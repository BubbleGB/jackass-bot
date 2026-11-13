import { describe, expect, it } from 'vitest';
import { CredentialCipher } from '../../src/settings/credentials.js';
const guild = '111111111111111111';
describe('authenticated provider credential envelopes', () => {
  const cipher = () => new CredentialCipher(1, new Map([[1, Buffer.alloc(32, 7)]]));
  it('round-trips only internally, uses fresh nonces and does not serialize keys', () => {
    const c = cipher(), a = c.seal(guild, 'openai', 'secret-key'), b = c.seal(guild, 'openai', 'secret-key');
    expect(c.open(guild, 'openai', a)).toBe('secret-key');
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(JSON.stringify(a)).not.toContain('secret-key');
    expect(JSON.stringify(c)).toBe('{}');
  });
  it('rejects tampering, another server/provider/version and wrong master key', () => {
    const c = cipher(), envelope = c.seal(guild, 'openai', 'secret-key');
    const corrupt = Buffer.from(envelope.ciphertext); corrupt[0] = (corrupt[0] ?? 0) ^ 1;
    for (const attempt of [
      () => c.open(guild, 'openai', { ...envelope, ciphertext: corrupt }),
      () => c.open('222222222222222222', 'openai', envelope),
      () => c.open(guild, 'google', envelope),
      () => c.open(guild, 'openai', { ...envelope, keyVersion: 2 }),
      () => new CredentialCipher(1, new Map([[1, Buffer.alloc(32, 8)]])).open(guild, 'openai', envelope),
    ]) expect(attempt).toThrow('credential_invalid');
  });
  it('supports old-version reads and fresh active-version writes for rotation', () => {
    const a = cipher().seal(guild, 'openai', 'secret-key');
    const c = new CredentialCipher(2, new Map([[1, Buffer.alloc(32, 7)], [2, Buffer.alloc(32, 8)]]));
    const rotated = c.seal(guild, 'openai', c.open(guild, 'openai', a));
    expect(rotated.keyVersion).toBe(2); expect(c.open(guild, 'openai', rotated)).toBe('secret-key');
  });
});
