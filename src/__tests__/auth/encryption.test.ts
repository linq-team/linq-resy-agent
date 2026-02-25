import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

describe('encryption', () => {
  // We need to test with and without CREDENTIAL_ENCRYPTION_KEY.
  // Because the module reads the env var at import time, we use dynamic imports
  // and reset modules between tests.

  describe('with encryption key', () => {
    const TEST_KEY = crypto.randomBytes(32).toString('hex');

    beforeEach(() => {
      vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', TEST_KEY);
      vi.resetModules();
    });

    it('encrypt → decrypt roundtrip preserves data', async () => {
      const { encrypt, decrypt } = await import('../../auth/encryption.js');
      const data = { resyAuthToken: 'eyJtoken123', nested: { x: 1 } };
      const encrypted = encrypt(data);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toEqual(data);
    });

    it('decrypt fails with wrong key', async () => {
      const { encrypt } = await import('../../auth/encryption.js');
      const encrypted = encrypt({ secret: 'value' });

      // Re-import with different key
      const wrongKey = crypto.randomBytes(32).toString('hex');
      vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', wrongKey);
      vi.resetModules();
      const { decrypt } = await import('../../auth/encryption.js');

      expect(() => decrypt(encrypted)).toThrow();
    });

    it('decrypt fails with tampered ciphertext', async () => {
      const { encrypt, decrypt } = await import('../../auth/encryption.js');
      const encrypted = encrypt({ secret: 'value' });
      const parts = encrypted.split(':');
      // Tamper with the ciphertext (last part)
      const tampered = parts[0] + ':' + parts[1] + ':' + parts[2].replace(/./g, 'A');
      expect(() => decrypt(tampered)).toThrow();
    });
  });

  describe('without encryption key (dev fallback)', () => {
    beforeEach(() => {
      vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', '');
      vi.resetModules();
    });

    it('uses plain:base64 format', async () => {
      const { encrypt, decrypt } = await import('../../auth/encryption.js');
      const data = { resyAuthToken: 'test-token-123' };
      const encrypted = encrypt(data);
      expect(encrypted).toMatch(/^plain:/);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toEqual(data);
    });
  });
});
