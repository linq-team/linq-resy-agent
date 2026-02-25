// Conversation and user profile storage backed by DynamoDB.
// Conversations expire after 24 hours (via DynamoDB TTL). User profiles persist.

import { getItem, putItem, deleteItem } from '../db/dynamodb.js';

const CONVERSATION_TTL_S = 24 * 60 * 60; // 24 hours
const MAX_MESSAGES = 50;

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  handle?: string;
}

interface ConversationRecord {
  messages: StoredMessage[];
  lastActive: number;
}

export interface UserProfile {
  handle: string;
  name: string | null;
  facts: string[];
  firstSeen: number;
  lastSeen: number;
}

// ── Conversations ──────────────────────────────────────────────────────────

export async function getConversation(chatId: string): Promise<StoredMessage[]> {
  const record = await getItem<ConversationRecord>(`CONV#${chatId}`, 'CONV');
  if (!record) return [];
  return record.messages ?? [];
}

export async function addMessage(chatId: string, role: 'user' | 'assistant', content: string, handle?: string): Promise<void> {
  const record = await getItem<ConversationRecord>(`CONV#${chatId}`, 'CONV');
  const messages = record?.messages ?? [];
  const msg: StoredMessage = { role, content };
  if (handle) msg.handle = handle;
  messages.push(msg);
  const trimmed = messages.slice(-MAX_MESSAGES);

  await putItem(`CONV#${chatId}`, 'CONV', {
    messages: trimmed,
    lastActive: Date.now(),
  }, CONVERSATION_TTL_S);
}

export async function clearConversation(chatId: string): Promise<void> {
  await deleteItem(`CONV#${chatId}`, 'CONV');
}

export async function clearAllConversations(): Promise<void> {
  // In DynamoDB, this would require a scan+delete which is expensive.
  // For the Lambda architecture, individual conversations expire via TTL.
  // This is only used by dev /clear-all — log a warning.
  console.warn('[state] clearAllConversations is a no-op in DynamoDB mode');
}

// ── User Profiles ───────────────────────────────────────────────────────────

export async function getUserProfile(handle: string): Promise<UserProfile | null> {
  const record = await getItem<UserProfile>(`USERPROFILE#${handle}`, 'USERPROFILE');
  return record ?? null;
}

export async function updateUserProfile(handle: string, updates: { name?: string; facts?: string[] }): Promise<void> {
  const existing = await getUserProfile(handle);
  const now = Math.floor(Date.now() / 1000);
  const profile: UserProfile = {
    handle,
    name: updates.name ?? existing?.name ?? null,
    facts: updates.facts ?? existing?.facts ?? [],
    firstSeen: existing?.firstSeen ?? now,
    lastSeen: now,
  };
  await putItem(`USERPROFILE#${handle}`, 'USERPROFILE', profile as unknown as Record<string, unknown>);
  console.log(`[state] Updated profile for ${handle}: name=${profile.name}, facts=${profile.facts.length}`);
}

export async function addUserFact(handle: string, fact: string): Promise<boolean> {
  const existing = await getUserProfile(handle);
  const facts = existing?.facts ? [...existing.facts] : [];
  if (facts.includes(fact)) return false;
  facts.push(fact);
  await updateUserProfile(handle, { facts });
  return true;
}

export async function setUserName(handle: string, name: string): Promise<boolean> {
  const existing = await getUserProfile(handle);
  if (existing?.name === name) return false;
  await updateUserProfile(handle, { name });
  return true;
}

export async function clearUserProfile(handle: string): Promise<boolean> {
  await deleteItem(`USERPROFILE#${handle}`, 'USERPROFILE');
  console.log(`[state] Cleared profile for ${handle}`);
  return true;
}

// No cleanup intervals needed — DynamoDB TTL handles conversation expiry.
