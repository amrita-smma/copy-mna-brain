import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Symmetric encryption for third-party credentials stored at rest (OAuth
 * access/refresh tokens). AES-256-GCM with a random 96-bit IV per value, so
 * the same token encrypts differently each time and tampering is detected.
 *
 * The key is derived from `AUTH_SECRET` with HKDF under a per-purpose label,
 * so no second secret has to be provisioned and each purpose gets its own
 * key. Rotating `AUTH_SECRET` makes every stored ciphertext undecryptable —
 * callers must treat {@link TokenDecryptionError} as "credential gone" and ask
 * the user to reconnect, never as a crash.
 *
 * Ciphertext format: `v1.<iv>.<tag>.<data>`, each part base64url.
 */

const VERSION = 'v1';
const IV_BYTES = 12;

export class TokenDecryptionError extends Error {
  constructor(message = 'Stored credential could not be decrypted') {
    super(message);
    this.name = 'TokenDecryptionError';
  }
}

export class TokenCipher {
  private readonly key: Buffer;

  /**
   * @param purpose distinct label per use, e.g. `meeting-intelligence-tokens`
   * @param secret  defaults to `AUTH_SECRET`
   */
  constructor(purpose: string, secret: string | undefined = process.env.AUTH_SECRET) {
    if (!secret) {
      throw new Error('AUTH_SECRET is not set; cannot encrypt stored credentials');
    }
    this.key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `mna-brain:${purpose}`, 32));
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
  }

  decrypt(ciphertext: string): string {
    const parts = ciphertext.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new TokenDecryptionError('Unrecognised credential format');
    }
    try {
      const [, iv, tag, data] = parts as [string, string, string, string];
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw new TokenDecryptionError();
    }
  }
}
