import Anthropic from '@anthropic-ai/sdk';
import { getConversation, addMessage, clearConversation, getUserProfile, setUserName, addUserFact, clearUserProfile, UserProfile, StoredMessage } from '../state/conversation.js';
import { searchRestaurants, findSlots, bookReservation, getReservations, cancelReservation } from '../bookings/index.js';
import type { BookingsCredentials } from '../auth/types.js';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a helpful AI reservation assistant accessible via text message. You're powered by Claude (Anthropic) and connected to Resy for restaurant reservations.

Built on the Linq messaging platform (linqapp.com), which bridges iMessage and RCS to your backend.

## What You Do
- Search for restaurants on Resy
- Check available time slots for specific dates and party sizes
- Book reservations directly through Resy
- View and cancel upcoming reservations
- Provide recommendations based on cuisine, location, and preferences

## Resy Booking Flow
1. Search for restaurants → get venue IDs
2. Find available slots for a venue/date/party size → get config tokens
3. Book using a config token (this is a real reservation — always confirm with the user first)
4. Cancel using a resy_token from an existing reservation

## Conversation Awareness
You have full access to the conversation history. USE IT:
- Reference previous searches, restaurants discussed, and bookings made
- If someone said "book that one" — look back in the history for which restaurant/slot they mean
- Track what venues youve already searched, what slots youve shown, and what was booked or cancelled
- When the user follows up vaguely ("how about tomorrow instead", "try 8pm", "the second one"), resolve it from context
- If you made a booking earlier in the conversation, remember the details (venue, time, party size, resy_token)

## Response Style
You're texting — write like you're texting a helpful friend who knows all the best spots.

CRITICAL: Mirror how humans actually text:
- Use "---" to split your response into separate messages sent individually
- Each message should be 1-2 sentences max
- ALWAYS split longer responses into 2-4 separate messages with ---
- This is NOT optional — multi-sentence responses MUST be split

Guidelines:
- NO markdown (no bullets, headers, bold, numbered lists)
- Lowercase by default
- Skip apostrophes — "dont", "cant", "im", "thats"
- Be concise — "table for 4 at 7pm, confirmed" not "Your reservation has been confirmed for a party of four..."
- When showing search results, lead with the most relevant options
- When listing restaurants or time slots, present them in a natural texting format (not numbered lists)

## Commands
- /clear — reset conversation history
- /forget me — erase everything the agent knows about you
- /help — show available commands
- /bookings — show upcoming reservations

## Web Search
Use web search proactively when users ask about restaurants — look up reviews, menus, hours, etc.

## Reactions
React to messages sparingly — text responses are always preferred. Use reactions only as supplements.

Standard: love, like, dislike, laugh, emphasize, question
Custom: any emoji

RULES:
1. Default to text — reactions are supplementary
2. Never react without also sending text unless its truly just an acknowledgment
3. Never write "[reacted with ...]" in your text

## Message Effects
Only use when explicitly requested or for truly special moments.

Effects: confetti, fireworks, lasers, balloons, sparkles, celebration
Bubble: slam, loud, gentle, invisible_ink

DEFAULT: Just text. Only add effects if asked.`;

function buildSystemPrompt(chatContext?: ChatContext): string {
  let prompt = SYSTEM_PROMPT;

  // Add user profile info if available
  if (chatContext?.senderHandle) {
    const profile = chatContext.senderProfile;
    if (profile?.name || (profile?.facts && profile.facts.length > 0)) {
      prompt += `\n\n## About the person you're talking to (YOU ALREADY KNOW THIS - don't re-save it!)`;
      prompt += `\nHandle: ${chatContext.senderHandle}`;
      if (profile.name) {
        prompt += `\nName: ${profile.name} (already saved - do NOT call remember_user for this)`;
      }
      if (profile.facts && profile.facts.length > 0) {
        prompt += `\nThings you remember about them (already saved):\n- ${profile.facts.join('\n- ')}`;
      }
      prompt += `\n\nUse their name naturally in conversation! Only use remember_user for genuinely NEW info.`;
    } else {
      prompt += `\n\n## About the person you're talking to
Handle: ${chatContext.senderHandle}
You don't know their name yet. If they share it or it comes up naturally, use the remember_user tool to save it!`;
    }
  }

  if (chatContext?.isGroupChat) {
    const participants = chatContext.participantNames.join(', ');
    const chatName = chatContext.chatName ? `"${chatContext.chatName}"` : 'an unnamed group';
    prompt += `\n\n## Group Chat Context
You're in a group chat called ${chatName} with these participants: ${participants}

In group chats:
- Address people by name when responding to them specifically
- Be aware others can see your responses
- Keep responses even shorter since group chats move fast
- Don't react as often in groups - it can feel spammy`;
  }

  if (chatContext?.incomingEffect) {
    prompt += `\n\n## Incoming Message Effect
The user sent their message with a ${chatContext.incomingEffect.type} effect: "${chatContext.incomingEffect.name}". You can acknowledge this if relevant.`;
  }

  if (chatContext?.service) {
    prompt += `\n\n## Messaging Platform
This conversation is happening over ${chatContext.service}.`;
    if (chatContext.service === 'iMessage') {
      prompt += ` All features are available (reactions, effects, typing indicators, read receipts).`;
    } else if (chatContext.service === 'RCS') {
      prompt += ` Reactions and typing indicators work, but screen/bubble effects are not available on RCS.`;
    } else if (chatContext.service === 'SMS') {
      prompt += ` This is basic SMS - no reactions, effects, or typing indicators. Keep responses simple and concise.`;
    }
  }

  if (chatContext?.justOnboarded) {
    prompt += `\n\n## IMPORTANT CONTEXT
This user JUST connected their account moments ago. This is their first message after completing onboarding. Welcome them and offer to help them find and book a reservation.`;
  }

  return prompt;
}

const REACTION_TOOL: Anthropic.Tool = {
  name: 'send_reaction',
  description: 'Send an iMessage reaction to the user\'s message. Use standard tapbacks (love, like, laugh, etc.) OR any custom emoji.',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'custom'],
        description: 'The reaction type. Use "custom" to send any emoji.',
      },
      emoji: {
        type: 'string',
        description: 'Required when type is "custom". The emoji to react with.',
      },
    },
    required: ['type'],
  },
};

const EFFECT_TOOL: Anthropic.Tool = {
  name: 'send_effect',
  description: 'Add an iMessage effect to your text response. ONLY use when the user explicitly asks for an effect. You MUST also write a text message.',
  input_schema: {
    type: 'object' as const,
    properties: {
      effect_type: {
        type: 'string',
        enum: ['screen', 'bubble'],
        description: 'Whether this is a full-screen effect or a bubble effect',
      },
      effect: {
        type: 'string',
        enum: ['confetti', 'fireworks', 'lasers', 'sparkles', 'celebration', 'hearts', 'love', 'balloons', 'happy_birthday', 'echo', 'spotlight', 'slam', 'loud', 'gentle', 'invisible_ink'],
        description: 'The specific effect to use',
      },
    },
    required: ['effect_type', 'effect'],
  },
};

const RENAME_CHAT_TOOL: Anthropic.Tool = {
  name: 'rename_group_chat',
  description: 'Rename the current group chat. ONLY use when someone EXPLICITLY asks to rename/name the chat.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: {
        type: 'string',
        description: 'The new name for the group chat',
      },
    },
    required: ['name'],
  },
};

const REMEMBER_USER_TOOL: Anthropic.Tool = {
  name: 'remember_user',
  description: 'Save NEW information about someone. ONLY use when you learn genuinely NEW info. NEVER re-save info already shown in the system prompt. CRITICAL: You MUST write a text response too.',
  input_schema: {
    type: 'object' as const,
    properties: {
      handle: {
        type: 'string',
        description: 'The phone number/handle of the person this info is about.',
      },
      name: {
        type: 'string',
        description: 'The person\'s name if they shared it.',
      },
      fact: {
        type: 'string',
        description: 'An interesting fact about them worth remembering.',
      },
    },
  },
};

// Web search uses a special tool type
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
} as unknown as Anthropic.Tool;

// ─── Resy Tools ─────────────────────────────────────────────────────────────

const RESY_SEARCH_TOOL: Anthropic.Tool = {
  name: 'resy_search',
  description: 'Search for restaurants on Resy. Use when someone asks about finding a place to eat or a restaurant. Returns venue IDs needed for checking availability.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Search keyword (e.g., "italian", "sushi", "steakhouse", "Carbone").',
      },
      lat: {
        type: 'number',
        description: 'Latitude for location-based search. Defaults to NYC.',
      },
      lng: {
        type: 'number',
        description: 'Longitude for location-based search. Defaults to NYC.',
      },
    },
    required: ['query'],
  },
};

const RESY_FIND_SLOTS_TOOL: Anthropic.Tool = {
  name: 'resy_find_slots',
  description: 'Find available time slots at a Resy venue for a given date and party size. Returns config tokens needed for booking.',
  input_schema: {
    type: 'object' as const,
    properties: {
      venue_id: {
        type: 'number',
        description: 'The Resy venue ID (from resy_search results).',
      },
      date: {
        type: 'string',
        description: 'Date to check (YYYY-MM-DD format).',
      },
      party_size: {
        type: 'number',
        description: 'Number of guests.',
      },
      lat: {
        type: 'number',
        description: 'Latitude. Defaults to NYC.',
      },
      lng: {
        type: 'number',
        description: 'Longitude. Defaults to NYC.',
      },
    },
    required: ['venue_id', 'date', 'party_size'],
  },
};

const RESY_BOOK_TOOL: Anthropic.Tool = {
  name: 'resy_book',
  description: 'Book a reservation on Resy. Automatically finds a fresh slot at booking time so tokens dont expire. This makes a REAL reservation — always confirm venue, date, time, and party size with the user before calling this.',
  input_schema: {
    type: 'object' as const,
    properties: {
      venue_id: {
        type: 'number',
        description: 'The Resy venue ID (from resy_search results).',
      },
      date: {
        type: 'string',
        description: 'Reservation date (YYYY-MM-DD).',
      },
      party_size: {
        type: 'number',
        description: 'Number of guests.',
      },
      time: {
        type: 'string',
        description: 'Desired time in HH:MM 24h format (e.g., "19:00"). Picks the closest available slot.',
      },
    },
    required: ['venue_id', 'date', 'party_size'],
  },
};

const RESY_CANCEL_TOOL: Anthropic.Tool = {
  name: 'resy_cancel',
  description: 'Cancel a Resy reservation using the resy_token (rr://... format). Get this from resy_reservations results.',
  input_schema: {
    type: 'object' as const,
    properties: {
      resy_token: {
        type: 'string',
        description: 'The resy_token for the reservation to cancel (rr://... format).',
      },
    },
    required: ['resy_token'],
  },
};

const RESY_RESERVATIONS_TOOL: Anthropic.Tool = {
  name: 'resy_reservations',
  description: 'View the user\'s upcoming Resy reservations. Use when someone asks about their bookings, reservations, or upcoming dinner plans.',
  input_schema: {
    type: 'object' as const,
    properties: {},
  },
};

// Tools that return data Claude needs to reason about (require tool-use loop)
const DATA_RETRIEVAL_TOOLS = new Set([
  'resy_search', 'resy_find_slots', 'resy_reservations',
  'resy_book', 'resy_cancel',
]);

const MAX_TOOL_LOOPS = 5;

export type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';
export type ReactionType = StandardReactionType | 'custom';
export type MessageEffect = { type: 'screen' | 'bubble'; name: string };

export type Reaction = {
  type: StandardReactionType;
} | {
  type: 'custom';
  emoji: string;
};

export interface ChatResponse {
  text: string | null;
  reaction: Reaction | null;
  effect: MessageEffect | null;
  renameChat: string | null;
  rememberedUser: { name?: string; fact?: string; isForSender?: boolean } | null;
}

export interface ImageInput {
  url: string;
  mimeType: string;
}

export interface AudioInput {
  url: string;
  mimeType: string;
}

export type MessageService = 'iMessage' | 'SMS' | 'RCS';

export interface ChatContext {
  isGroupChat: boolean;
  participantNames: string[];
  chatName: string | null;
  incomingEffect?: { type: 'screen' | 'bubble'; name: string };
  senderHandle?: string;
  senderProfile?: UserProfile | null;
  service?: MessageService;
  bookingsCredentials?: BookingsCredentials | null;
  justOnboarded?: boolean;
}

/**
 * Convert stored messages to Anthropic format, adding sender attribution for group chats.
 */
function formatHistoryForClaude(messages: StoredMessage[], isGroupChat: boolean): Anthropic.MessageParam[] {
  return messages.map(msg => {
    let content = msg.content;
    if (isGroupChat && msg.role === 'user' && msg.handle) {
      content = `[${msg.handle}]: ${content}`;
    }
    return { role: msg.role, content };
  });
}

export async function chat(chatId: string, userMessage: string, images: ImageInput[] = [], audio: AudioInput[] = [], chatContext?: ChatContext): Promise<ChatResponse> {
  const emptyResponse = {
    reaction: null,
    effect: null,
    renameChat: null,
    rememberedUser: null,
  };

  const cmd = userMessage.toLowerCase().trim();

  // Handle special commands
  if (cmd === '/help') {
    return {
      text: "commands:\n/clear - reset our conversation\n/forget me - erase what i know about you\n/bookings - show your reservations\n/help - this message",
      ...emptyResponse,
    };
  }

  if (cmd === '/clear') {
    await clearConversation(chatId);
    return { text: "conversation cleared, fresh start", ...emptyResponse };
  }

  if (cmd === '/forget me' || cmd === '/forgetme') {
    if (chatContext?.senderHandle) {
      await clearUserProfile(chatContext.senderHandle);
      return { text: "done, ive forgotten everything about you. were strangers now", ...emptyResponse };
    }
    return { text: "hmm couldnt figure out who you are to forget you", ...emptyResponse };
  }

  // Per-user Resy auth token
  const resyAuthToken = chatContext?.bookingsCredentials?.resyAuthToken ?? null;

  // Get conversation history
  const history = await getConversation(chatId);

  // Build message content
  const messageContent: Anthropic.ContentBlockParam[] = [];

  for (const image of images) {
    messageContent.push({
      type: 'image',
      source: { type: 'url', url: image.url },
    });
  }

  let textToSend = userMessage.trim();
  if (!textToSend && images.length > 0) {
    textToSend = "What's in this image?";
  }
  if (textToSend) {
    messageContent.push({ type: 'text', text: textToSend });
  }

  if (textToSend) {
    await addMessage(chatId, 'user', textToSend, chatContext?.senderHandle);
  }

  try {
    const formattedHistory = formatHistoryForClaude(history, chatContext?.isGroupChat ?? false);

    // Build tools list
    const tools: Anthropic.Tool[] = [
      REACTION_TOOL, EFFECT_TOOL, REMEMBER_USER_TOOL, WEB_SEARCH_TOOL,
    ];
    if (resyAuthToken) {
      tools.push(
        RESY_SEARCH_TOOL, RESY_FIND_SLOTS_TOOL,
        RESY_BOOK_TOOL, RESY_CANCEL_TOOL,
        RESY_RESERVATIONS_TOOL,
      );
    }
    if (chatContext?.isGroupChat) {
      tools.push(RENAME_CHAT_TOOL);
    }

    // ── Tool-use loop ──────────────────────────────────────────────────────
    let bookingSucceeded = false; // Track if a resy_book call succeeded
    const messages: Anthropic.MessageParam[] = [...formattedHistory, { role: 'user', content: messageContent }];
    let response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: buildSystemPrompt(chatContext),
      tools,
      messages,
    });

    let loopCount = 0;
    while (response.stop_reason === 'tool_use' && loopCount < MAX_TOOL_LOOPS) {
      const hasDataTools = response.content.some(
        block => block.type === 'tool_use' && DATA_RETRIEVAL_TOOLS.has(block.name)
      );
      if (!hasDataTools) break;

      console.log(`[claude] Tool-use loop iteration ${loopCount + 1}`);

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        // ── Resy tool execution ───────────────────────────────────
        if (block.name === 'resy_search') {
          const input = block.input as { query: string; lat?: number; lng?: number };
          try {
            const geo = input.lat && input.lng ? { lat: input.lat, lng: input.lng } : undefined;
            const results = await searchRestaurants(resyAuthToken!, input.query, geo);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(results) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] resy_search error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error searching restaurants: ${msg}`, is_error: true });
          }

        } else if (block.name === 'resy_find_slots') {
          const input = block.input as { venue_id: number; date: string; party_size: number; lat?: number; lng?: number };
          try {
            const geo = input.lat && input.lng ? { lat: input.lat, lng: input.lng } : undefined;
            const slots = await findSlots(resyAuthToken!, input.venue_id, input.date, input.party_size, geo);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(slots) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] resy_find_slots error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error finding slots: ${msg}`, is_error: true });
          }

        } else if (block.name === 'resy_book') {
          const input = block.input as { venue_id: number; date: string; party_size: number; time?: string };
          try {
            const confirmation = await bookReservation(resyAuthToken!, input.venue_id, input.date, input.party_size, input.time);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(confirmation) });
            bookingSucceeded = true;
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] resy_book error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error booking reservation: ${msg}`, is_error: true });
          }

        } else if (block.name === 'resy_cancel') {
          const input = block.input as { resy_token: string };
          try {
            const result = await cancelReservation(resyAuthToken!, input.resy_token);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] resy_cancel error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error cancelling reservation: ${msg}`, is_error: true });
          }

        } else if (block.name === 'resy_reservations') {
          try {
            const reservations = await getReservations(resyAuthToken!);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(reservations) });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            console.error('[claude] resy_reservations error:', msg);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error fetching reservations: ${msg}`, is_error: true });
          }

        } else {
          // Fire-and-forget tools
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'ok' });
        }
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: buildSystemPrompt(chatContext),
        tools,
        messages,
      });

      loopCount++;
    }

    // ── Extract fire-and-forget tools from ALL responses ─────────────────
    let reaction: Reaction | null = null;
    let effect: MessageEffect | null = null;
    let renameChat: string | null = null;
    let rememberedUser: { name?: string; fact?: string; isForSender?: boolean } | null = null;

    const allAssistantBlocks = messages
      .filter((m): m is Anthropic.MessageParam & { role: 'assistant' } => m.role === 'assistant')
      .flatMap(m => Array.isArray(m.content) ? m.content : []);
    const allBlocks = [...allAssistantBlocks, ...response.content];

    for (const block of allBlocks) {
      if (block.type === 'tool_use' && block.name === 'send_reaction') {
        const input = block.input as { type: ReactionType; emoji?: string };
        if (input.type === 'custom' && input.emoji) {
          reaction = { type: 'custom', emoji: input.emoji };
        } else if (input.type !== 'custom') {
          reaction = { type: input.type as StandardReactionType };
        }
      } else if (block.type === 'tool_use' && block.name === 'send_effect') {
        const input = block.input as { effect_type: 'screen' | 'bubble'; effect: string };
        effect = { type: input.effect_type, name: input.effect };
      } else if (block.type === 'tool_use' && block.name === 'rename_group_chat') {
        const input = block.input as { name: string };
        renameChat = input.name;
      } else if (block.type === 'tool_use' && block.name === 'remember_user') {
        const input = block.input as { handle?: string; name?: string; fact?: string };
        const targetHandle = input.handle || chatContext?.senderHandle;
        if (targetHandle) {
          let nameChanged = false;
          let factChanged = false;

          if (input.name) {
            nameChanged = await setUserName(targetHandle, input.name);
          }
          if (input.fact) {
            factChanged = await addUserFact(targetHandle, input.fact);
          }

          if (nameChanged || factChanged) {
            const isForSender = !input.handle || input.handle === chatContext?.senderHandle;
            rememberedUser = {
              name: nameChanged ? input.name : undefined,
              fact: factChanged ? input.fact : undefined,
              isForSender
            };
          }
        }
      }
    }

    // Auto-celebration: if a booking was successfully made, send confetti
    if (bookingSucceeded && !effect) {
      effect = { type: 'screen', name: 'celebration' };
      console.log('[claude] Auto-attaching celebration effect for successful booking');
    }

    // Only take text from the FINAL response
    const finalTextParts: string[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        finalTextParts.push(block.text);
      }
    }
    const textResponse = finalTextParts.length > 0 ? finalTextParts.join('\n') : null;

    // Build a summary of tool calls for conversation history
    // This lets Claude reference prior searches, bookings, etc. in follow-up messages
    const toolSummaryParts: string[] = [];
    for (const block of allBlocks) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'resy_search') {
        const input = block.input as { query: string };
        toolSummaryParts.push(`[searched resy for "${input.query}"]`);
      } else if (block.name === 'resy_find_slots') {
        const input = block.input as { venue_id: number; date: string; party_size: number };
        toolSummaryParts.push(`[checked slots: venue ${input.venue_id}, ${input.date}, party of ${input.party_size}]`);
      } else if (block.name === 'resy_book') {
        toolSummaryParts.push(`[booked a reservation]`);
      } else if (block.name === 'resy_cancel') {
        toolSummaryParts.push(`[cancelled a reservation]`);
      } else if (block.name === 'resy_reservations') {
        toolSummaryParts.push(`[checked upcoming reservations]`);
      }
    }

    // Add assistant response to history (include tool context so Claude remembers what it did)
    if (textResponse) {
      const cleanedText = textResponse.split('---').map(m => m.trim()).filter(m => m).join(' ');
      const historyMessage = toolSummaryParts.length > 0
        ? `${toolSummaryParts.join(' ')} ${cleanedText}`
        : cleanedText;
      await addMessage(chatId, 'assistant', historyMessage);
    } else if (effect) {
      await addMessage(chatId, 'assistant', `[sent ${effect.name} effect]`);
    } else if (reaction) {
      const reactionDisplay = reaction.type === 'custom' ? (reaction as { type: 'custom'; emoji: string }).emoji : reaction.type;
      await addMessage(chatId, 'assistant', `[reacted with ${reactionDisplay}]`);
    }

    return { text: textResponse, reaction, effect, renameChat, rememberedUser };
  } catch (error) {
    console.error('[claude] API error:', error);
    throw error;
  }
}

/**
 * Simple text-only completion for follow-up requests (no tools).
 */
export async function getTextForEffect(effectName: string): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: `Write a very short, fun message (under 10 words) to send with a ${effectName} iMessage effect. Just the message, nothing else.`
    }],
  });

  if (response.content[0].type === 'text') {
    return response.content[0].text;
  }
  return `${effectName}!`;
}

export type GroupChatAction = 'respond' | 'react' | 'ignore';

/**
 * Use Haiku to quickly determine how Claude should handle a group chat message.
 */
export async function getGroupChatAction(
  message: string,
  sender: string,
  chatId: string
): Promise<{ action: GroupChatAction; reaction?: Reaction }> {
  const start = Date.now();
  const history = await getConversation(chatId);
  const recentMessages = history.slice(-4);

  let contextBlock = '';
  if (recentMessages.length > 0) {
    const formatted = recentMessages.map(msg => {
      if (msg.role === 'assistant') return `Assistant: ${msg.content}`;
      const sender = msg.handle || 'Someone';
      return `${sender}: ${msg.content}`;
    }).join('\n');
    contextBlock = `\nRecent conversation:\n${formatted}\n`;
  }

  try {
    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 20,
      system: `You classify how an AI booking assistant should handle messages in a group chat.

IMPORTANT: BIAS TOWARD "respond" - text responses are almost always better than reactions.

Answer with ONE of these:
- "respond" - The assistant should send a text reply. USE THIS BY DEFAULT when:
  * They asked about restaurants, bookings, reservations, or plans
  * They mentioned the bot or assistant
  * They're continuing a conversation
  * You're unsure - default to respond
- "react:love" or "react:like" or "react:laugh" - ONLY for brief acknowledgments
- "ignore" - Human-to-human conversation not involving the assistant`,
      messages: [{
        role: 'user',
        content: `${contextBlock}New message from ${sender}: "${message}"\n\nHow should the assistant handle this?`
      }],
    });

    const answer = response.content[0].type === 'text'
      ? response.content[0].text.toLowerCase().trim()
      : 'ignore';

    let action: GroupChatAction = 'ignore';
    let reaction: Reaction | undefined;

    if (answer.includes('respond')) {
      action = 'respond';
    } else if (answer.includes('react')) {
      action = 'react';
      if (answer.includes('love')) reaction = { type: 'love' };
      else if (answer.includes('laugh')) reaction = { type: 'laugh' };
      else if (answer.includes('like')) reaction = { type: 'like' };
      else reaction = { type: 'like' };
    }

    console.log(`[claude] groupChatAction (${Date.now() - start}ms): "${message.substring(0, 50)}..." -> ${action}`);
    return { action, reaction };
  } catch (error) {
    console.error('[claude] groupChatAction error:', error);
    return { action: 'ignore' };
  }
}
