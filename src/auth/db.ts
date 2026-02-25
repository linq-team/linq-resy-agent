import type { User, BookingsCredentials, AuthToken } from './types.js';
import { encrypt, decrypt } from './encryption.js';
import { redactPhone } from '../utils/redact.js';
import { getItem, putItem, deleteItem, updateItem } from '../db/dynamodb.js';

// DynamoDB key prefixes (single-table design)
const USER_PK = (phone: string) => `USER#${phone}`;

// ── Users ──────────────────────────────────────────────────────────────────

interface UserRecord {
  phoneNumber: string;
  createdAt: string;
  lastActive: string;
  onboardingComplete: boolean;
}

function toUser(record: UserRecord): User {
  return {
    phoneNumber: record.phoneNumber,
    createdAt: new Date(record.createdAt),
    lastActive: new Date(record.lastActive),
    onboardingComplete: record.onboardingComplete,
  };
}

export async function getUser(phoneNumber: string): Promise<User | null> {
  const record = await getItem<UserRecord>(USER_PK(phoneNumber), 'PROFILE');
  return record ? toUser(record) : null;
}

export async function createUser(phoneNumber: string): Promise<User> {
  const now = new Date().toISOString();
  const record: UserRecord = {
    phoneNumber,
    createdAt: now,
    lastActive: now,
    onboardingComplete: false,
  };
  await putItem(USER_PK(phoneNumber), 'PROFILE', record as unknown as Record<string, unknown>);
  console.log(`[auth] Created user: ${redactPhone(phoneNumber)}`);
  return toUser(record);
}

export async function updateLastActive(phoneNumber: string): Promise<void> {
  await updateItem(USER_PK(phoneNumber), 'PROFILE', {
    lastActive: new Date().toISOString(),
  });
}

// ── Credentials ────────────────────────────────────────────────────────────

export async function getCredentials(phoneNumber: string): Promise<BookingsCredentials | null> {
  const record = await getItem<{ encrypted: string }>(USER_PK(phoneNumber), 'CREDENTIALS');
  if (!record) return null;
  try {
    return decrypt(record.encrypted) as BookingsCredentials;
  } catch (err) {
    console.error(`[auth] Failed to decrypt credentials for ${redactPhone(phoneNumber)}:`, err);
    return null;
  }
}

export async function setCredentials(phoneNumber: string, creds: BookingsCredentials): Promise<void> {
  const encrypted = encrypt(creds);
  await putItem(USER_PK(phoneNumber), 'CREDENTIALS', { encrypted });

  // Mark onboarding complete
  await updateItem(USER_PK(phoneNumber), 'PROFILE', { onboardingComplete: true });

  // Mark as recently onboarded (10 minute TTL)
  await putItem(USER_PK(phoneNumber), 'JUST_ONBOARDED', {}, 10 * 60);

  console.log(`[auth] Stored encrypted credentials for ${redactPhone(phoneNumber)}`);
}

export async function clearCredentials(phoneNumber: string): Promise<void> {
  await deleteItem(USER_PK(phoneNumber), 'CREDENTIALS');
  // Mark as signed out
  await putItem(USER_PK(phoneNumber), 'SIGNED_OUT', {});
  await updateItem(USER_PK(phoneNumber), 'PROFILE', { onboardingComplete: false });
  console.log(`[auth] Cleared credentials for ${redactPhone(phoneNumber)}`);
}

export async function isSignedOut(phoneNumber: string): Promise<boolean> {
  const record = await getItem(USER_PK(phoneNumber), 'SIGNED_OUT');
  return record !== null;
}

export async function clearSignedOut(phoneNumber: string): Promise<void> {
  await deleteItem(USER_PK(phoneNumber), 'SIGNED_OUT');
}

/**
 * Check if user just completed onboarding (one-shot: returns true once, then clears).
 */
export async function consumeJustOnboarded(phoneNumber: string): Promise<boolean> {
  const record = await getItem(USER_PK(phoneNumber), 'JUST_ONBOARDED');
  if (record) {
    await deleteItem(USER_PK(phoneNumber), 'JUST_ONBOARDED');
    return true;
  }
  return false;
}

// ── Pending OTP (SMS auth) ─────────────────────────────────────────────────

export async function setPendingOTP(phoneNumber: string, chatId: string): Promise<void> {
  await putItem(USER_PK(phoneNumber), 'PENDING_OTP', {
    chatId,
    sentAt: new Date().toISOString(),
  }, 5 * 60); // 5 minute TTL
  console.log(`[auth] OTP pending for ${redactPhone(phoneNumber)}`);
}

export async function getPendingOTP(phoneNumber: string): Promise<{ chatId: string; sentAt: Date } | null> {
  const record = await getItem<{ chatId: string; sentAt: string }>(USER_PK(phoneNumber), 'PENDING_OTP');
  if (!record) return null;
  return { chatId: record.chatId, sentAt: new Date(record.sentAt) };
}

export async function clearPendingOTP(phoneNumber: string): Promise<void> {
  await deleteItem(USER_PK(phoneNumber), 'PENDING_OTP');
}

// ── Pending Challenge (email verification after OTP) ─────────────────────

interface PendingChallenge {
  chatId: string;
  claimToken: string;
  challengeId: string;
  mobileNumber: string;
  firstName: string;
  isNewUser: boolean;
  requiredFields: Array<{ name: string; type: string; message: string }>;
  sentAt: string;
}

export async function setPendingChallenge(phoneNumber: string, data: Omit<PendingChallenge, 'sentAt'>): Promise<void> {
  await putItem(USER_PK(phoneNumber), 'PENDING_CHALLENGE', {
    ...data,
    sentAt: new Date().toISOString(),
  } as unknown as Record<string, unknown>, 10 * 60); // 10 minute TTL
  console.log(`[auth] Challenge pending for ${redactPhone(phoneNumber)} (needs email verification)`);
}

export async function getPendingChallenge(phoneNumber: string): Promise<PendingChallenge | null> {
  const record = await getItem<PendingChallenge>(USER_PK(phoneNumber), 'PENDING_CHALLENGE');
  return record ?? null;
}

export async function clearPendingChallenge(phoneNumber: string): Promise<void> {
  await deleteItem(USER_PK(phoneNumber), 'PENDING_CHALLENGE');
}

// ── Auth Tokens (magic links) ──────────────────────────────────────────────

export async function createAuthToken(phoneNumber: string, chatId: string, token: string, ttlMinutes: number = 15): Promise<AuthToken> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
  const authToken: AuthToken = {
    token,
    phoneNumber,
    chatId,
    createdAt: now,
    expiresAt,
    used: false,
  };

  await putItem(`AUTHTOKEN#${token}`, 'AUTHTOKEN', {
    token,
    phoneNumber,
    chatId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    used: false,
  }, ttlMinutes * 60 + 60); // TTL with 1 minute buffer

  console.log(`[auth] Created auth token for ${redactPhone(phoneNumber)} (expires in ${ttlMinutes}m)`);
  return authToken;
}

export async function verifyAuthToken(token: string): Promise<string | null> {
  const record = await getItem<{
    phoneNumber: string;
    expiresAt: string;
    used: boolean;
  }>(`AUTHTOKEN#${token}`, 'AUTHTOKEN');
  if (!record) return null;
  if (record.used) return null;
  if (new Date() > new Date(record.expiresAt)) return null;
  return record.phoneNumber;
}

export async function getAuthTokenChatId(token: string): Promise<string | null> {
  const record = await getItem<{ chatId: string }>(`AUTHTOKEN#${token}`, 'AUTHTOKEN');
  if (!record) return null;
  return record.chatId;
}

export async function markAuthTokenUsed(token: string): Promise<void> {
  await updateItem(`AUTHTOKEN#${token}`, 'AUTHTOKEN', { used: true });
}

// No cleanup intervals needed — DynamoDB TTL handles expiry automatically.
