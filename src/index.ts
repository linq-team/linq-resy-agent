import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { createWebhookHandler } from './webhook/handler.js';
import { sendMessage, markAsRead, startTyping, sendReaction, shareContactCard, getChat, renameGroupChat } from './linq/client.js';
import { chat, getGroupChatAction, getTextForEffect } from './claude/client.js';
import { getUserProfile, addMessage } from './state/conversation.js';
import { authRoutes, getUser, createUser, loadUserContext, consumeJustOnboarded, setPendingOTP, getPendingOTP, clearPendingOTP, setPendingChallenge, getPendingChallenge, clearPendingChallenge, setCredentials, clearSignedOut } from './auth/index.js';
import { sendResyOTP, verifyResyOTP, completeResyChallenge } from './bookings/index.js';
import { redactPhone } from './utils/redact.js';
import { putItem } from './db/dynamodb.js';

// Clean up LLM response formatting quirks before sending
function cleanResponse(text: string): string {
  return text
    // Turn newline-dash into inline dash (e.g., "foo\n - bar" → "foo - bar")
    .replace(/\n\s*-\s*/g, ' - ')
    // Remove markdown underlines/italics (_text_ → text)
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    // Remove markdown bold (**text** → text)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // Remove stray asterisks used for emphasis
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    // Clean up multiple spaces
    .replace(/  +/g, ' ')
    // Clean up extra newlines (but preserve intentional double-newlines for --- splits)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Track message count per chat for contact card sharing (DynamoDB-backed)
const CONTACT_CARD_INTERVAL = 5; // Share every N messages

async function getChatMessageCount(chatId: string): Promise<number> {
  const { getItem } = await import('./db/dynamodb.js');
  const record = await getItem<{ count: number }>(`CHATCOUNT#${chatId}`, 'CHATCOUNT');
  return record?.count ?? 0;
}

async function setChatMessageCount(chatId: string, count: number): Promise<void> {
  await putItem(`CHATCOUNT#${chatId}`, 'CHATCOUNT', { count }, 7 * 24 * 60 * 60); // 7 day TTL
}

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies (cap at 50KB to prevent abuse — PEM keys are ~2KB)
app.use(express.json({ limit: '50kb' }));

// Security headers on all responses
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// HTTPS enforcement in production (behind proxy like Railway/ngrok)
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] === 'http') {
      res.redirect(301, `https://${req.headers.host}${req.url}`);
      return;
    }
    next();
  });
}

// Serve static assets (fonts, images) — public/ lives at project root
app.use(express.static(path.join(process.cwd(), 'public')));

// Auth routes (onboarding page + credential submission)
app.use(authRoutes);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Webhook endpoint for Linq Blue
app.post(
  '/linq-webhook',
  createWebhookHandler(async (chatId, from, text, messageId, images, audio, incomingEffect, incomingReplyTo, service) => {
    const start = Date.now();
    console.log(`[main] Processing message from ${redactPhone(from)}`);

    // Track message count for this chat
    const prevCount = await getChatMessageCount(chatId);
    const count = prevCount + 1;
    await setChatMessageCount(chatId, count);

    // Share contact card on first message or every N messages
    const shouldShareContact = count === 1 || count % CONTACT_CARD_INTERVAL === 0;

    // Mark as read, start typing, get chat info, and fetch user profile in parallel
    const parallelTasks: Promise<unknown>[] = [markAsRead(chatId), startTyping(chatId), getChat(chatId), getUserProfile(from)];
    if (shouldShareContact) {
      console.log(`[main] Sharing contact card (message #${count})`);
      parallelTasks.push(shareContactCard(chatId));
    }
    const [, , chatInfo, senderProfile] = await Promise.all(parallelTasks) as [void, void, Awaited<ReturnType<typeof getChat>>, Awaited<ReturnType<typeof getUserProfile>>];
    console.log(`[timing] markAsRead+startTyping+getChat+getProfile${shouldShareContact ? '+shareContact' : ''}: ${Date.now() - start}ms`);
    if (senderProfile?.name) {
      console.log(`[main] Known user: ${senderProfile.name} (${senderProfile.facts.length} facts)`);
    }

    // Determine if this is a group chat (more than 2 participants)
    const isGroupChat = chatInfo.handles.length > 2;
    const participantNames = chatInfo.handles.map(h => h.handle);

    // ── Inline JWT auth: user texts their Resy token directly ─────────────
    const trimmedText = text.trim();
    if (trimmedText.startsWith('eyJ') && trimmedText.length > 100) {
      console.log(`[main] User ${redactPhone(from)} sent a JWT token directly`);
      if (!(await getUser(from))) await createUser(from);
      await setCredentials(from, { resyAuthToken: trimmedText });
      await clearSignedOut(from);
      await clearPendingOTP(from);
      await sendMessage(chatId, `you're all set! your resy account is connected`);
      await new Promise(resolve => setTimeout(resolve, 800));
      await sendMessage(chatId, `i can search restaurants, find open tables, make reservations, and manage your bookings — just text me what you need`);
      console.log(`[main] JWT stored for ${redactPhone(from)}`);
      return;
    }

    // ── Email challenge: user needs to verify email after OTP code ────────
    const pendingChallenge = await getPendingChallenge(from);
    if (pendingChallenge) {
      const emailInput = text.trim().toLowerCase();
      // Basic email validation
      if (emailInput.includes('@') && emailInput.includes('.')) {
        console.log(`[main] User ${redactPhone(from)} sent email for challenge verification`);

        // Build field values from the challenge's required fields
        const fieldValues: Record<string, string> = {};
        for (const field of pendingChallenge.requiredFields) {
          if (field.type === 'email' || field.name === 'em_address') {
            fieldValues[field.name] = emailInput;
          }
        }

        const authToken = await completeResyChallenge(
          {
            claimToken: pendingChallenge.claimToken,
            challengeId: pendingChallenge.challengeId,
            mobileNumber: pendingChallenge.mobileNumber,
            firstName: pendingChallenge.firstName,
            requiredFields: pendingChallenge.requiredFields,
          },
          fieldValues,
        );

        if (authToken) {
          if (!(await getUser(from))) await createUser(from);
          await setCredentials(from, { resyAuthToken: authToken });
          await clearPendingChallenge(from);
          await clearSignedOut(from);

          await sendMessage(chatId, `you're all set! your resy account is connected`);
          await new Promise(resolve => setTimeout(resolve, 800));
          await sendMessage(chatId, `i can search restaurants, find open tables, make reservations, and manage your bookings — just text me what you need`);
          console.log(`[main] Challenge completed — credentials stored for ${redactPhone(from)}`);
          return;
        } else {
          await sendMessage(chatId, `that email didn't match your resy account — try the email address you used to sign up for resy`);
          console.log(`[main] Challenge verification failed for ${redactPhone(from)}`);
          return;
        }
      }
      // Non-email text while challenge is pending
      await sendMessage(chatId, `i need the email address on your resy account to finish connecting — what email did you use to sign up for resy?`);
      return;
    }

    // ── OTP code check: if user is mid-onboarding and sends a code ────────
    const pendingOtp = await getPendingOTP(from);
    if (pendingOtp) {
      // Strip dashes, spaces, dots from input (users may type "322-311" or "322 311")
      const stripped = text.trim().replace(/[\s\-\.]/g, '');
      // Accept 4-6 digit codes
      if (/^\d{4,6}$/.test(stripped)) {
        console.log(`[main] User ${redactPhone(from)} sent OTP code, verifying...`);
        const result = await verifyResyOTP(from, stripped);

        if (!result) {
          await sendMessage(chatId, `that code didn't work — check the text from resy and try again`);
          console.log(`[main] OTP verification failed for ${redactPhone(from)}`);
          return;
        }

        if ('token' in result) {
          // Direct token — rare but possible
          if (!(await getUser(from))) await createUser(from);
          await setCredentials(from, { resyAuthToken: result.token });
          await clearPendingOTP(from);
          await clearSignedOut(from);

          await sendMessage(chatId, `you're all set! your resy account is connected`);
          await new Promise(resolve => setTimeout(resolve, 800));
          await sendMessage(chatId, `i can search restaurants, find open tables, make reservations, and manage your bookings — just text me what you need`);
          console.log(`[main] OTP verified (direct token) — credentials stored for ${redactPhone(from)}`);
          return;
        }

        // Challenge — need email verification
        const challenge = result.challenge;
        await clearPendingOTP(from);
        await setPendingChallenge(from, {
          chatId,
          claimToken: challenge.claimToken,
          challengeId: challenge.challengeId,
          mobileNumber: challenge.mobileNumber,
          firstName: challenge.firstName,
          requiredFields: challenge.requiredFields,
        });

        const name = challenge.firstName ? ` ${challenge.firstName}` : '';
        await sendMessage(chatId, `got it${name}! one more step — what's the email address on your resy account?`);
        console.log(`[main] OTP accepted, challenge pending (needs email) for ${redactPhone(from)}`);
        return;
      }
      // User sent non-code text while OTP is pending — remind them
      await sendMessage(chatId, `i'm still waiting for your resy verification code — check your texts for a 6-digit code from resy`);
      return;
    }

    // ── Auth check: ensure user has Bookings credentials ──────────────────
    const userCtx = await loadUserContext(from);
    if (!userCtx) {
      // New user or incomplete onboarding — send Resy SMS OTP
      if (!(await getUser(from))) {
        await createUser(from);
        console.log(`[main] New user: ${redactPhone(from)}`);
      } else {
        console.log(`[main] User ${redactPhone(from)} exists but no credentials`);
      }

      // Send SMS OTP
      const otpResult = await sendResyOTP(from);
      if (otpResult === 'sms') {
        await setPendingOTP(from, chatId);
        await sendMessage(chatId, `hey! i just sent a verification code to this number from resy`);
        await new Promise(resolve => setTimeout(resolve, 600));
        await sendMessage(chatId, `send me the 6-digit code to connect your account`);
        console.log(`[main] Sent Resy OTP to ${redactPhone(from)}`);
      } else if (otpResult === 'rate_limited') {
        // SMS rate limited — tell the user honestly and offer JWT fallback
        await sendMessage(chatId, `resy is temporarily blocking verification texts to your number (too many recent attempts)`);
        await new Promise(resolve => setTimeout(resolve, 600));
        await sendMessage(chatId, `you can connect by pasting your resy auth token directly — go to resy.com, open browser dev tools, and copy the x-resy-auth-token header value, then text it to me`);
        console.log(`[main] SMS rate limited for ${redactPhone(from)}, offered JWT fallback`);
      } else {
        // OTP failed entirely — phone might not be on Resy
        await sendMessage(chatId, `i couldn't send a verification code to this number — make sure you have a resy account linked to this phone number`);
        await new Promise(resolve => setTimeout(resolve, 600));
        await sendMessage(chatId, `alternatively, you can paste your resy auth token directly — go to resy.com, log in, open dev tools, and copy the x-resy-auth-token header from any api request`);
        console.log(`[main] OTP send failed for ${redactPhone(from)}`);
      }
      return;
    }

    // In group chats, check if Claude should respond, react, or ignore
    // Always respond to voice memos/images - someone sending media is clearly trying to communicate
    if (isGroupChat && audio.length === 0 && images.length === 0) {
      const { action, reaction: quickReaction } = await getGroupChatAction(text, from, chatId);

      if (action === 'ignore') {
        console.log(`[main] Ignoring group chat message`);
        return;
      }

      if (action === 'react') {
        // Just send a reaction, no full response needed
        if (quickReaction) {
          await sendReaction(messageId, quickReaction);
          console.log(`[timing] quick reaction: ${Date.now() - start}ms`);

          // Save to conversation history so Claude knows what happened (include sender for group chats)
          await addMessage(chatId, 'user', text, from);
          const reactionDisplay = quickReaction.type === 'custom' ? (quickReaction as { type: 'custom'; emoji: string }).emoji : quickReaction.type;
          await addMessage(chatId, 'assistant', `[reacted with ${reactionDisplay}]`);

          console.log(`[main] Reacted to ${redactPhone(from)} with ${reactionDisplay}`);
        }
        return;
      }

      console.log(`[main] Claude should respond to this group message`);
    } else if (isGroupChat) {
      console.log(`[main] Responding to group media (skipping classifier)`);
    }

    // Check if user just completed onboarding (one-shot flag)
    const justOnboarded = await consumeJustOnboarded(from);
    if (justOnboarded) {
      console.log(`[main] User ${redactPhone(from)} just completed onboarding — injecting context`);
    }

    // Get Claude's response (typing indicator shows while this runs)
    const { text: responseText, reaction, effect, renameChat, rememberedUser } = await chat(chatId, text, images, audio, {
      isGroupChat,
      participantNames,
      chatName: chatInfo.display_name,
      incomingEffect,
      senderHandle: from,
      senderProfile,
      service,
      bookingsCredentials: userCtx.bookingsCredentials,
      justOnboarded,
    });
    console.log(`[timing] claude: ${Date.now() - start}ms`);
    console.log(`[debug] responseText: ${responseText ? `"${responseText.substring(0, 50)}..."` : 'null'}, effect: ${effect ? JSON.stringify(effect) : 'null'}, renameChat: ${renameChat || 'null'}`);

    // Send reaction if Claude wants to
    if (reaction) {
      await sendReaction(messageId, reaction);
      console.log(`[timing] reaction: ${Date.now() - start}ms`);
    }

    // Rename group chat if Claude wants to
    if (renameChat && isGroupChat) {
      await renameGroupChat(chatId, renameChat);
      console.log(`[timing] renameChat: ${Date.now() - start}ms`);
    }

    // Send text response if there is one (with optional effect)
    // If Claude chose an effect but no text, get text from Haiku
    let finalText = responseText;
    if (!finalText && effect) {
      console.log(`[main] Claude sent effect without text, getting message from Haiku...`);
      finalText = await getTextForEffect(effect.name);
      console.log(`[timing] effect text followup: ${Date.now() - start}ms`);
    }

    // If Claude renamed chat but didn't send text, add a simple acknowledgment (group chats only)
    if (!finalText && renameChat && isGroupChat) {
      console.log(`[main] Claude renamed chat without text, adding acknowledgment`);
      finalText = `renamed the chat to "${renameChat}" 😎`;
    }

    // If Claude used remember_user without text, just log it - no automatic acknowledgments
    // Claude should write its own response if it wants to acknowledge learning something
    if (!finalText && rememberedUser) {
      console.log(`[main] Claude saved user info without text response (no auto-ack)`);
    }

    if (finalText) {
      // Split into multiple messages first, then clean each one
      // (must split before cleaning, or the --- delimiter gets mangled)
      const messages = finalText.split('---').map(m => cleanResponse(m)).filter(m => m.length > 0);

      // If the incoming message was a reply, continue the thread by replying to that message
      const replyTo = incomingReplyTo ? { message_id: messageId } : undefined;

      if (messages.length > 0) {
        for (let i = 0; i < messages.length; i++) {
          const isLastMessage = i === messages.length - 1;
          const messageEffect = isLastMessage ? effect ?? undefined : undefined;
          const messageReplyTo = (i === 0) ? replyTo : undefined;

          await sendMessage(chatId, messages[i], messageEffect, messageReplyTo);

          // Add a natural delay between messages (except after the last one)
          if (!isLastMessage) {
            const delay = 400 + Math.random() * 400; // 400-800ms feels natural
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
        console.log(`[timing] sendMessage (${messages.length} text msg${messages.length !== 1 ? 's' : ''}): ${Date.now() - start}ms`);
      }

      const extras = [effect && 'effect', replyTo && 'thread'].filter(Boolean).join(', ');
      console.log(`[timing] total: ${Date.now() - start}ms (${extras || 'text only'})`);
    } else if (reaction) {
      // Reaction-only response - already saved to conversation history by chat()
      console.log(`[main] Reaction-only response (saved to history for context)`);
    }

    console.log(`[main] Reply sent to ${redactPhone(from)}`);
  })
);

// Only start Express server when NOT running inside Lambda
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║              Linq Bookings Agent                      ║
╠═══════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}              ║
║                                                       ║
║  Endpoints:                                           ║
║    POST /linq-webhook  - Linq Blue webhook receiver   ║
║    GET  /health        - Health check                 ║
║    GET  /auth/setup    - Onboarding page              ║
║                                                       ║
║  Next steps:                                          ║
║    1. Run: ngrok http ${PORT}                            ║
║    2. Configure webhook URL in Linq Blue              ║
║    3. Text your Linq Blue number!                     ║
╚═══════════════════════════════════════════════════════╝
    `);
  });
}

// Export for Lambda handler usage
export { app };
