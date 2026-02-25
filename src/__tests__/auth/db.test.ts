import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DynamoDB wrapper
const store = new Map<string, unknown>();
vi.mock('../../db/dynamodb.js', () => ({
  getItem: vi.fn(async (pk: string, sk: string) => store.get(`${pk}||${sk}`) ?? null),
  putItem: vi.fn(async (pk: string, sk: string, data: Record<string, unknown>) => {
    store.set(`${pk}||${sk}`, { ...data });
  }),
  deleteItem: vi.fn(async (pk: string, sk: string) => {
    store.delete(`${pk}||${sk}`);
  }),
  updateItem: vi.fn(async (pk: string, sk: string, updates: Record<string, unknown>) => {
    const existing = (store.get(`${pk}||${sk}`) ?? {}) as Record<string, unknown>;
    store.set(`${pk}||${sk}`, { ...existing, ...updates });
  }),
}));

// Mock encryption so we can verify roundtrips without real keys
vi.mock('../../auth/encryption.js', () => ({
  encrypt: vi.fn((data: object) => `enc:${JSON.stringify(data)}`),
  decrypt: vi.fn((str: string) => JSON.parse(str.replace('enc:', ''))),
}));

import {
  getUser, createUser, updateLastActive,
  getCredentials, setCredentials, clearCredentials,
  isSignedOut, clearSignedOut, consumeJustOnboarded,
  setPendingOTP, getPendingOTP, clearPendingOTP,
  setPendingChallenge, getPendingChallenge, clearPendingChallenge,
  createAuthToken, verifyAuthToken, markAuthTokenUsed,
} from '../../auth/db.js';

beforeEach(() => {
  store.clear();
});

// ── Users ────────────────────────────────────────────────────────────────────

describe('users', () => {
  const phone = '+14155551234';

  it('createUser → getUser returns user', async () => {
    const user = await createUser(phone);
    expect(user.phoneNumber).toBe(phone);
    expect(user.onboardingComplete).toBe(false);

    const fetched = await getUser(phone);
    expect(fetched).not.toBeNull();
    expect(fetched!.phoneNumber).toBe(phone);
  });

  it('getUser returns null for nonexistent user', async () => {
    const user = await getUser('+10000000000');
    expect(user).toBeNull();
  });

  it('updateLastActive updates timestamp', async () => {
    await createUser(phone);
    const before = await getUser(phone);

    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 10));
    await updateLastActive(phone);

    const after = await getUser(phone);
    expect(after).not.toBeNull();
    // The mock merges updates, so lastActive should be updated
    expect(after!.lastActive).not.toEqual(before!.lastActive);
  });
});

// ── Credentials ──────────────────────────────────────────────────────────────

describe('credentials', () => {
  const phone = '+14155551234';

  it('setCredentials → getCredentials decrypts correctly', async () => {
    await createUser(phone);
    await setCredentials(phone, { resyAuthToken: 'tok_abc' });
    const creds = await getCredentials(phone);
    expect(creds).toEqual({ resyAuthToken: 'tok_abc' });
  });

  it('getCredentials returns null when no creds set', async () => {
    const creds = await getCredentials('+19999999999');
    expect(creds).toBeNull();
  });

  it('clearCredentials removes creds + sets signed-out flag', async () => {
    await createUser(phone);
    await setCredentials(phone, { resyAuthToken: 'tok_abc' });
    await clearCredentials(phone);
    const creds = await getCredentials(phone);
    expect(creds).toBeNull();
    expect(await isSignedOut(phone)).toBe(true);
  });
});

// ── Signed-out ───────────────────────────────────────────────────────────────

describe('signed-out', () => {
  const phone = '+14155551234';

  it('isSignedOut true after clearCredentials', async () => {
    await createUser(phone);
    await setCredentials(phone, { resyAuthToken: 'tok' });
    await clearCredentials(phone);
    expect(await isSignedOut(phone)).toBe(true);
  });

  it('clearSignedOut removes flag', async () => {
    await createUser(phone);
    await setCredentials(phone, { resyAuthToken: 'tok' });
    await clearCredentials(phone);
    await clearSignedOut(phone);
    expect(await isSignedOut(phone)).toBe(false);
  });
});

// ── Onboarding ───────────────────────────────────────────────────────────────

describe('onboarding', () => {
  const phone = '+14155551234';

  it('consumeJustOnboarded returns true once then false', async () => {
    await createUser(phone);
    await setCredentials(phone, { resyAuthToken: 'tok' });
    // setCredentials writes JUST_ONBOARDED
    expect(await consumeJustOnboarded(phone)).toBe(true);
    expect(await consumeJustOnboarded(phone)).toBe(false);
  });
});

// ── OTP ──────────────────────────────────────────────────────────────────────

describe('OTP', () => {
  const phone = '+14155551234';
  const chatId = 'chat_1';

  it('setPendingOTP → getPendingOTP returns data', async () => {
    await setPendingOTP(phone, chatId);
    const otp = await getPendingOTP(phone);
    expect(otp).not.toBeNull();
    expect(otp!.chatId).toBe(chatId);
  });

  it('getPendingOTP returns null when not set', async () => {
    const otp = await getPendingOTP('+10000000000');
    expect(otp).toBeNull();
  });

  it('clearPendingOTP removes OTP', async () => {
    await setPendingOTP(phone, chatId);
    await clearPendingOTP(phone);
    const otp = await getPendingOTP(phone);
    expect(otp).toBeNull();
  });
});

// ── Challenge ────────────────────────────────────────────────────────────────

describe('challenge', () => {
  const phone = '+14155551234';
  const challengeData = {
    chatId: 'chat_1',
    claimToken: 'ct_abc',
    challengeId: 'ch_123',
    mobileNumber: phone,
    firstName: 'Alice',
    requiredFields: [{ name: 'em_address', type: 'email', message: 'Enter email' }],
  };

  it('setPendingChallenge → getPendingChallenge returns data', async () => {
    await setPendingChallenge(phone, challengeData);
    const challenge = await getPendingChallenge(phone);
    expect(challenge).not.toBeNull();
    expect(challenge!.claimToken).toBe('ct_abc');
    expect(challenge!.firstName).toBe('Alice');
  });

  it('clearPendingChallenge removes challenge', async () => {
    await setPendingChallenge(phone, challengeData);
    await clearPendingChallenge(phone);
    const challenge = await getPendingChallenge(phone);
    expect(challenge).toBeNull();
  });
});

// ── Auth tokens ──────────────────────────────────────────────────────────────

describe('auth tokens', () => {
  const phone = '+14155551234';
  const chatId = 'chat_1';

  it('createAuthToken → verifyAuthToken returns phone', async () => {
    const authToken = await createAuthToken(phone, chatId, 'tok_random', 15);
    expect(authToken.phoneNumber).toBe(phone);

    const result = await verifyAuthToken('tok_random');
    expect(result).toBe(phone);
  });

  it('verifyAuthToken returns null for nonexistent token', async () => {
    const result = await verifyAuthToken('nonexistent');
    expect(result).toBeNull();
  });

  it('used token returns null', async () => {
    await createAuthToken(phone, chatId, 'tok_burn', 15);
    await markAuthTokenUsed('tok_burn');
    const result = await verifyAuthToken('tok_burn');
    expect(result).toBeNull();
  });

  it('expired token returns null', async () => {
    // Create token with data that looks expired
    store.set('AUTHTOKEN#tok_expired||AUTHTOKEN', {
      phoneNumber: phone,
      expiresAt: new Date(Date.now() - 60000).toISOString(),
      used: false,
    });
    const result = await verifyAuthToken('tok_expired');
    expect(result).toBeNull();
  });
});
