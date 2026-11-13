import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const key = Buffer.alloc(32, 7).toString('base64');
const runtime = { NODE_ENV: 'production', APP_MODE: 'runtime', PUBLIC_ORIGIN: 'https://galaxy.bubbleaio.uk', DATABASE_URL: 'postgresql://local:secret@localhost/galaxy', ENCRYPTION_KEY: key, ENCRYPTION_KEY_VERSION: '1', DISCORD_BOT_TOKEN: 'bot-secret', DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'oauth-secret', CREATOR_USER_ID: '223456789012345678' };

describe('loadConfig', () => {
  it('permits foundation/test checks without production credentials', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.mode).toBe('foundation');
    expect(config.port).toBe(3000);
  });
  it('rejects a missing production encryption key', () => {
    expect(() => loadConfig({ ...runtime, ENCRYPTION_KEY: undefined })).toThrow(/ENCRYPTION_KEY/);
  });
  it.each(['ftp://example.com', 'https://example.com/path', 'https://user:pass@example.com', 'https://example.com?key=secret', 'null', 'https://example.com#fragment'])('rejects non-origin input %s', (origin) => {
    expect(() => loadConfig({ PUBLIC_ORIGIN: origin })).toThrow(/PUBLIC_ORIGIN/);
  });
  it('requires HTTPS for production origins', () => {
    expect(() => loadConfig({ ...runtime, PUBLIC_ORIGIN: 'http://example.com' })).toThrow(/PUBLIC_ORIGIN/);
  });
  it('does not expose supplied secrets or URLs in validation errors', () => {
    let error: unknown;
    try { loadConfig({ ...runtime, DATABASE_URL: 'invalid-db-secret', ENCRYPTION_KEY: 'invalid-encryption-secret', DISCORD_CLIENT_ID: 'private-invalid-id' }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    const output = String(error) + JSON.stringify(error);
    for (const secret of ['invalid-db-secret', 'invalid-encryption-secret', 'private-invalid-id', 'bot-secret', 'oauth-secret']) expect(output).not.toContain(secret);
    expect(output).toContain('DATABASE_URL');
  });
  it('accepts valid production configuration and preserves snowflakes as strings', () => {
    const config = loadConfig(runtime);
    expect(config.creatorUserId).toBe('223456789012345678');
    expect(config.encryptionKey?.byteLength).toBe(32);
    expect(config.publicOrigin).toBe('https://galaxy.bubbleaio.uk');
  });
  it.each(['', 'ab', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64')])('rejects malformed encryption key %#', (value) => {
    expect(() => loadConfig({ ...runtime, ENCRYPTION_KEY: value })).toThrow(/ENCRYPTION_KEY/);
  });
  it.each(['-1', '0', '65536', '3.14', 'abc'])('rejects invalid ports %s', (port) => {
    expect(() => loadConfig({ PORT: port })).toThrow(/PORT/);
  });
  it.each(['PUBLIC_ORIGIN', 'DATABASE_URL', 'ENCRYPTION_KEY', 'DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'CREATOR_USER_ID'])('requires %s in runtime mode', (name) => {
    expect(() => loadConfig({ ...runtime, [name]: undefined })).toThrow(name);
  });
  it.each(['0', '-1', '1.5', '2147483648', 'oops'])('rejects invalid key versions %s', (version) => {
    expect(() => loadConfig({ ENCRYPTION_KEY_VERSION: version })).toThrow(/ENCRYPTION_KEY_VERSION/);
  });
  it('rejects unknown environments without echoing the supplied value', () => {
    expect(() => loadConfig({ NODE_ENV: 'private-bad-environment' })).toThrow('Invalid configuration fields: NODE_ENV');
  });
  it('rejects unknown runtime modes and database protocols', () => {
    expect(() => loadConfig({ APP_MODE: 'runntime' })).toThrow(/APP_MODE/);
    expect(() => loadConfig({ DATABASE_URL: 'https://localhost/db' })).toThrow(/DATABASE_URL/);
  });
});
