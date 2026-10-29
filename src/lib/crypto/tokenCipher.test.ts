import { describe, expect, it } from 'vitest';
import { TokenCipher, TokenDecryptionError } from './tokenCipher';

describe('TokenCipher', () => {
  const cipher = new TokenCipher('test-purpose', 'a-test-secret');

  it('round-trips a token', () => {
    const ct = cipher.encrypt('access-token-123');
    expect(ct).not.toContain('access-token-123');
    expect(cipher.decrypt(ct)).toBe('access-token-123');
  });

  it('encrypts the same plaintext differently each time', () => {
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('rejects a tampered ciphertext', () => {
    const [v, iv, tag, data] = cipher.encrypt('secret').split('.');
    const flipped = data!.startsWith('A') ? `B${data!.slice(1)}` : `A${data!.slice(1)}`;
    expect(() => cipher.decrypt([v, iv, tag, flipped].join('.'))).toThrow(TokenDecryptionError);
  });

  it('cannot decrypt under a different purpose or secret', () => {
    const ct = cipher.encrypt('secret');
    expect(() => new TokenCipher('other-purpose', 'a-test-secret').decrypt(ct)).toThrow(TokenDecryptionError);
    expect(() => new TokenCipher('test-purpose', 'rotated-secret').decrypt(ct)).toThrow(TokenDecryptionError);
  });

  it('rejects an unrecognised format', () => {
    expect(() => cipher.decrypt('plaintext-token')).toThrow(TokenDecryptionError);
  });

  it('refuses to construct without a secret', () => {
    expect(() => new TokenCipher('x', '')).toThrow(/AUTH_SECRET/);
  });
});
