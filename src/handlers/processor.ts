/**
 * Lambda #2 — "Processor"
 *
 * Triggered by SQS. Runs the main message processing pipeline:
 *   - Load state from DynamoDB
 *   - Claude API (tool-use loop)
 *   - Resy API calls
 *   - Send reply via Linq
 *   - Save state to DynamoDB
 *
 * Timeout: 60s (heavy Claude + Resy API calls)
 */

import type { SQSHandler, SQSRecord } from 'aws-lambda';
import type { MessageReceivedEvent } from '../webhook/types.js';
import {
  extractTextContent,
  extractImageUrls,
  extractAudioUrls,
} from '../webhook/types.js';
import { sendMessage, markAsRead, startTyping, sendReaction, shareContactCard, getChat, renameGroupChat } from '../linq/client.js';
import { chat, getGroupChatAction, getTextForEffect } from '../claude/client.js';
import { getUserProfile, setUserName, addMessage } from '../state/conversation.js';
import {
  getUser, createUser, loadUserContext, consumeJustOnboarded,
  setPendingOTP, getPendingOTP, clearPendingOTP,
  setPendingChallenge, getPendingChallenge, clearPendingChallenge,
  setCredentials, clearSignedOut,
} from '../auth/index.js';
import { sendResyOTP, verifyResyOTP, completeResyChallenge, registerResyUser } from '../bookings/index.js';
import { redactPhone } from '../utils/redact.js';
import { getItem, putItem } from '../db/dynamodb.js';

const CONTACT_CARD_INTERVAL = 5;

function cleanResponse(text: string): string {
  return text
    .replace(/\n\s*-\s*/g, ' - ')
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    .replace(/  +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function getChatMessageCount(chatId: string): Promise<number> {
  const record = await getItem<{ count: number }>(`CHATCOUNT#${chatId}`, 'CHATCOUNT');
  return record?.count ?? 0;
}

async function setChatMessageCount(chatId: string, count: number): Promise<void> {
  await putItem(`CHATCOUNT#${chatId}`, 'CHATCOUNT', { count }, 7 * 24 * 60 * 60);
}

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      console.error(`[processor] Error processing record:`, error);
      // Let the message go to DLQ on failure
      throw error;
    }
  }
};

async function processRecord(record: SQSRecord): Promise<void> {
  const webhookEvent = JSON.parse(record.body) as MessageReceivedEvent;
  const { chat_id: chatId, from, message, service } = webhookEvent.data;
  const messageId = message.id;

  const parts = message.parts ?? [];
  const text = extractTextContent(parts);
  const images = extractImageUrls(parts);
  const audio = extractAudioUrls(parts);
  const incomingEffect = message.effect;
  const incomingReplyTo = message.reply_to;

  const start = Date.now();
  console.log(`[processor] Processing message from ${redactPhone(from)}`);

  // Track message count for this chat
  const prevCount = await getChatMessageCount(chatId);
  const count = prevCount + 1;
  await setChatMessageCount(chatId, count);

  const shouldShareContact = count === 1 || count % CONTACT_CARD_INTERVAL === 0;

  // Mark as read, start typing, get chat info, and fetch user profile in parallel
  const parallelTasks: Promise<unknown>[] = [markAsRead(chatId), startTyping(chatId), getChat(chatId), getUserProfile(from)];
  if (shouldShareContact) {
    console.log(`[processor] Sharing contact card (message #${count})`);
    parallelTasks.push(shareContactCard(chatId));
  }
  const [, , chatInfo, senderProfile] = await Promise.all(parallelTasks) as [void, void, Awaited<ReturnType<typeof getChat>>, Awaited<ReturnType<typeof getUserProfile>>];
  console.log(`[timing] parallel init: ${Date.now() - start}ms`);

  if (senderProfile?.name) {
    console.log(`[processor] Known user: ${senderProfile.name} (${senderProfile.facts.length} facts)`);
  }

  const isGroupChat = chatInfo.handles.length > 2;
  const participantNames = chatInfo.handles.map(h => h.handle);

  // ── Inline JWT auth ─────────────────────────────────────────────────
  const trimmedText = text.trim();
  if (trimmedText.startsWith('eyJ') && trimmedText.length > 100) {
    console.log(`[processor] User ${redactPhone(from)} sent a JWT token directly`);
    if (!(await getUser(from))) await createUser(from);
    await setCredentials(from, { resyAuthToken: trimmedText });
    await clearSignedOut(from);
    await clearPendingOTP(from);
    await sendMessage(chatId, `you're all set! your resy account is connected`);
    await new Promise(resolve => setTimeout(resolve, 800));
    await sendMessage(chatId, `i can search restaurants, find open tables, make reservations, and manage your bookings — just text me what you need`);
    return;
  }

  // ── Email / registration challenge ──────────────────────────────────
  const pendingChallenge = await getPendingChallenge(from);
  if (pendingChallenge) {
    const input = text.trim();

    // No-challenge user: just need email to try connecting
    if (pendingChallenge.isNewUser) {
      const emailMatch = input.match(/[\w.+-]+@[\w.-]+\.\w+/i);
      if (emailMatch) {
        const email = emailMatch[0].toLowerCase();
        console.log(`[processor] No-challenge user, trying with email: ${email}`);

        // Try registerResyUser (hits multiple endpoints with logging)
        const authToken = await registerResyUser(
          pendingChallenge.claimToken,
          pendingChallenge.mobileNumber,
          '',  // first_name — let Resy use existing
          '',  // last_name — let Resy use existing
          email,
        );

        if (authToken) {
          if (!(await getUser(from))) await createUser(from);
          await setCredentials(from, { resyAuthToken: authToken });
          await clearPendingChallenge(from);
          await clearSignedOut(from);
          await sendMessage(chatId, `you're all set! your resy account is connected`);
          await new Promise(resolve => setTimeout(resolve, 800));
          await sendMessage(chatId, `i can search restaurants, find open tables, make reservations, and manage your bookings — just text me what you need`);
          return;
        } else {
          await clearPendingChallenge(from);
          await sendMessage(chatId, `i'm having trouble connecting your account automatically`);
          await new Promise(resolve => setTimeout(resolve, 600));
          await sendMessage(chatId, `you can connect manually: log into resy.com, open browser dev tools (F12), go to Network tab, click any request, and copy the "x-resy-auth-token" header value — then paste it here`);
          return;
        }
      }
      await sendMessage(chatId, `what's the email address on your resy account?`);
      return;
    }

    // Existing user challenge: just need email
    const emailInput = input.toLowerCase();
    if (emailInput.includes('@') && emailInput.includes('.')) {
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
          isNewUser: false,
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
        return;
      } else {
        await sendMessage(chatId, `that email didn't match your resy account — try the email address you used to sign up for resy`);
        return;
      }
    }
    await sendMessage(chatId, `i need the email address on your resy account to finish connecting — what email did you use to sign up for resy?`);
    return;
  }

  // ── OTP code check ──────────────────────────────────────────────────
  const pendingOtp = await getPendingOTP(from);
  if (pendingOtp) {
    const stripped = text.trim().replace(/[\s\-\.]/g, '');
    if (/^\d{4,6}$/.test(stripped)) {
      const result = await verifyResyOTP(from, stripped);

      if (!result) {
        await sendMessage(chatId, `that code didn't work — check the text from resy and try again`);
        return;
      }

      if ('error' in result) {
        console.error(`[processor] Resy server error verifying OTP for ${redactPhone(from)}`);
        await sendMessage(chatId, `resy's servers are having issues right now — wait a minute and i'll resend a new code`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        const retry = await sendResyOTP(from);
        if (retry === 'sms') {
          await setPendingOTP(from, chatId);
          await sendMessage(chatId, `just sent a new code — try again with the fresh one`);
        }
        return;
      }

      if ('token' in result) {
        if (!(await getUser(from))) await createUser(from);
        await setCredentials(from, { resyAuthToken: result.token });
        await clearPendingOTP(from);
        await clearSignedOut(from);
        await sendMessage(chatId, `you're all set! your resy account is connected`);
        await new Promise(resolve => setTimeout(resolve, 800));
        await sendMessage(chatId, `i can search restaurants, find open tables, make reservations, and manage your bookings — just text me what you need`);
        return;
      }

      const challenge = result.challenge;
      await clearPendingOTP(from);
      await setPendingChallenge(from, {
        chatId,
        claimToken: challenge.claimToken,
        challengeId: challenge.challengeId,
        mobileNumber: challenge.mobileNumber,
        firstName: challenge.firstName,
        isNewUser: challenge.isNewUser,
        requiredFields: challenge.requiredFields,
      });

      if (challenge.isNewUser) {
        await sendMessage(chatId, `almost there! i need your resy email to finish connecting — what email did you use for resy?`);
      } else {
        const name = challenge.firstName ? ` ${challenge.firstName}` : '';
        await sendMessage(chatId, `got it${name}! one more step — what's the email address on your resy account?`);
      }
      return;
    }
    await sendMessage(chatId, `i'm still waiting for your resy verification code — check your texts for a 6-digit code from resy`);
    return;
  }

  // ── Auth check ──────────────────────────────────────────────────────
  const userCtx = await loadUserContext(from);
  if (!userCtx) {
    if (!(await getUser(from))) {
      await createUser(from);
      console.log(`[processor] New user: ${redactPhone(from)}`);
    }

    const otpResult = await sendResyOTP(from);
    if (otpResult === 'sms') {
      await setPendingOTP(from, chatId);
      await sendMessage(chatId, `hey! i just sent a verification code to this number from resy`);
      await new Promise(resolve => setTimeout(resolve, 600));
      await sendMessage(chatId, `send me the 6-digit code to connect your account`);
    } else if (otpResult === 'rate_limited') {
      await sendMessage(chatId, `resy is temporarily blocking verification texts to your number (too many recent attempts)`);
      await new Promise(resolve => setTimeout(resolve, 600));
      await sendMessage(chatId, `you can connect by pasting your resy auth token directly — go to resy.com, open browser dev tools, and copy the x-resy-auth-token header value, then text it to me`);
    } else {
      await sendMessage(chatId, `i couldn't send a verification code to this number — make sure you have a resy account linked to this phone number`);
      await new Promise(resolve => setTimeout(resolve, 600));
      await sendMessage(chatId, `alternatively, you can paste your resy auth token directly — go to resy.com, log in, open dev tools, and copy the x-resy-auth-token header from any api request`);
    }
    return;
  }

  // ── Group chat classifier ───────────────────────────────────────────
  if (isGroupChat && audio.length === 0 && images.length === 0) {
    const { action, reaction: quickReaction } = await getGroupChatAction(text, from, chatId);

    if (action === 'ignore') {
      console.log(`[processor] Ignoring group chat message`);
      return;
    }

    if (action === 'react') {
      if (quickReaction) {
        await sendReaction(messageId, quickReaction);
        await addMessage(chatId, 'user', text, from);
        const reactionDisplay = quickReaction.type === 'custom' ? (quickReaction as { type: 'custom'; emoji: string }).emoji : quickReaction.type;
        await addMessage(chatId, 'assistant', `[reacted with ${reactionDisplay}]`);
      }
      return;
    }
  }

  // ── Main Claude response ────────────────────────────────────────────
  const justOnboarded = await consumeJustOnboarded(from);

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

  if (reaction) {
    await sendReaction(messageId, reaction);
  }

  if (renameChat && isGroupChat) {
    await renameGroupChat(chatId, renameChat);
  }

  let finalText = responseText;
  if (!finalText && effect) {
    finalText = await getTextForEffect(effect.name);
  }
  if (!finalText && renameChat && isGroupChat) {
    finalText = `renamed the chat to "${renameChat}" 😎`;
  }

  if (finalText) {
    const messages = finalText.split('---').map(m => cleanResponse(m)).filter(m => m.length > 0);
    const replyTo = incomingReplyTo ? { message_id: messageId } : undefined;

    for (let i = 0; i < messages.length; i++) {
      const isLastMessage = i === messages.length - 1;
      const messageEffect = isLastMessage ? effect ?? undefined : undefined;
      const messageReplyTo = (i === 0) ? replyTo : undefined;

      await sendMessage(chatId, messages[i], messageEffect, messageReplyTo);

      if (!isLastMessage) {
        const delay = 400 + Math.random() * 400;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  console.log(`[processor] Done for ${redactPhone(from)} (${Date.now() - start}ms)`);
}
