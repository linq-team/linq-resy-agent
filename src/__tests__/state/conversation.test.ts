import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory store mock for DynamoDB
const store = new Map<string, unknown>();
vi.mock('../../db/dynamodb.js', () => ({
  getItem: vi.fn(async (pk: string, sk: string) => store.get(`${pk}||${sk}`) ?? null),
  putItem: vi.fn(async (pk: string, sk: string, data: Record<string, unknown>) => {
    store.set(`${pk}||${sk}`, { ...data });
  }),
  deleteItem: vi.fn(async (pk: string, sk: string) => {
    store.delete(`${pk}||${sk}`);
  }),
}));

import {
  getConversation, addMessage, clearConversation,
  getUserProfile, setUserName, addUserFact, clearUserProfile,
} from '../../state/conversation.js';

beforeEach(() => {
  store.clear();
});

// ── Conversations ────────────────────────────────────────────────────────────

describe('conversations', () => {
  it('getConversation returns empty array for new chat', async () => {
    const msgs = await getConversation('new_chat');
    expect(msgs).toEqual([]);
  });

  it('addMessage appends to conversation', async () => {
    await addMessage('chat_1', 'user', 'hello');
    await addMessage('chat_1', 'assistant', 'hi there');

    const msgs = await getConversation('chat_1');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'user', content: 'hello' });
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'hi there' });
  });

  it('messages trimmed to max 50', async () => {
    // Add 55 messages
    for (let i = 0; i < 55; i++) {
      await addMessage('chat_full', 'user', `msg ${i}`);
    }

    const msgs = await getConversation('chat_full');
    expect(msgs).toHaveLength(50);
    // Oldest messages should be trimmed — first message should be msg 5
    expect(msgs[0].content).toBe('msg 5');
    expect(msgs[49].content).toBe('msg 54');
  });

  it('clearConversation removes all messages', async () => {
    await addMessage('chat_2', 'user', 'hello');
    await clearConversation('chat_2');
    const msgs = await getConversation('chat_2');
    expect(msgs).toEqual([]);
  });
});

// ── User Profiles ────────────────────────────────────────────────────────────

describe('user profiles', () => {
  it('getUserProfile returns null for unknown handle', async () => {
    const profile = await getUserProfile('unknown_user');
    expect(profile).toBeNull();
  });

  it('setUserName creates/updates profile', async () => {
    const changed = await setUserName('alice', 'Alice');
    expect(changed).toBe(true);

    const profile = await getUserProfile('alice');
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe('Alice');

    // Same name = no change
    const noChange = await setUserName('alice', 'Alice');
    expect(noChange).toBe(false);
  });

  it('addUserFact adds fact and deduplicates', async () => {
    const added = await addUserFact('bob', 'likes sushi');
    expect(added).toBe(true);

    const dup = await addUserFact('bob', 'likes sushi');
    expect(dup).toBe(false);

    const profile = await getUserProfile('bob');
    expect(profile!.facts).toEqual(['likes sushi']);
  });

  it('clearUserProfile removes profile', async () => {
    await setUserName('charlie', 'Charlie');
    const cleared = await clearUserProfile('charlie');
    expect(cleared).toBe(true);

    const profile = await getUserProfile('charlie');
    expect(profile).toBeNull();
  });
});
