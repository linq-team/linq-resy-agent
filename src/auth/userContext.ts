import type { User, BookingsCredentials } from './types.js';
import { getUser, getCredentials, updateLastActive, createUser } from './db.js';

export interface UserContext {
  user: User;
  bookingsCredentials: BookingsCredentials;
}

/** Env-level Resy token — when set, skips per-user onboarding. */
const ENV_RESY_AUTH_TOKEN = process.env.RESY_AUTH_TOKEN || '';

/**
 * Load a user's context (user record + decrypted credentials).
 *
 * Priority:
 * 1. Per-user encrypted credentials (from onboarding)
 * 2. Env-level RESY_AUTH_TOKEN fallback (for dev / single-operator mode)
 * 3. null → triggers onboarding flow
 */
export function loadUserContext(phoneNumber: string): UserContext | null {
  let user = getUser(phoneNumber);

  // Per-user credentials take priority
  if (user) {
    const creds = getCredentials(phoneNumber);
    if (creds) {
      updateLastActive(phoneNumber);
      return { user, bookingsCredentials: creds };
    }
  }

  // Fallback: env-level token (skip onboarding entirely)
  if (ENV_RESY_AUTH_TOKEN) {
    if (!user) {
      user = createUser(phoneNumber);
    }
    updateLastActive(phoneNumber);
    return {
      user,
      bookingsCredentials: { resyAuthToken: ENV_RESY_AUTH_TOKEN },
    };
  }

  return null;
}
