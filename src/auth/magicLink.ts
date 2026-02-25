import crypto from 'node:crypto';
import { createAuthToken, verifyAuthToken, markAuthTokenUsed } from './db.js';
import { redactPhone } from '../utils/redact.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const MAGIC_LINK_TTL_MINUTES = 15;

export interface MagicLink {
  url: string;
  token: string;
  expiresAt: Date;
}

/**
 * Generate a magic link for a phone number.
 * Creates a cryptographically random token with 15-minute TTL.
 */
export async function generateMagicLink(phoneNumber: string, chatId: string): Promise<MagicLink> {
  const token = crypto.randomBytes(32).toString('base64url');
  const authToken = await createAuthToken(phoneNumber, chatId, token, MAGIC_LINK_TTL_MINUTES);

  const url = `${BASE_URL}/auth/setup?token=${token}`;

  console.log(`[auth] Generated magic link for ${redactPhone(phoneNumber)}`);
  return { url, token, expiresAt: authToken.expiresAt };
}

/**
 * Verify a magic link token. Returns the phone number if valid, null otherwise.
 * Burns the token on successful verification.
 */
export async function verifyMagicLinkToken(token: string): Promise<string | null> {
  const phoneNumber = await verifyAuthToken(token);
  if (!phoneNumber) return null;
  await markAuthTokenUsed(token);
  return phoneNumber;
}

/**
 * Build the iMessage text the agent sends to onboard a new user.
 */
export function buildOnboardingMessage(magicLink: MagicLink): string {
  return `hey! before we get started, i need you to connect your resy account
---
tap here to set it up — takes 30 seconds:
---
${magicLink.url}`;
}
