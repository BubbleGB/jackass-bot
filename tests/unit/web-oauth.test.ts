import { describe,it,expect } from 'vitest';
import { DiscordOAuth } from '../../src/web/oauth.js';
describe('Discord confidential authorization-code adapter',() => {
  it('uses identify-only OAuth with exact redirect and single-attempt form exchange',async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const oauth = new DiscordOAuth('111111111111111111','fake-client-secret','https://example.test',async (url,init) => { calls.push({ url: String(url),init: init! }); return new Response(JSON.stringify(calls.length === 1 ? { access_token: 'fake-access-token' } : { id: '222222222222222222' })); });
    const u = new URL(oauth.authorize('browser-bound-state')); expect(u.origin).toBe('https://discord.com'); expect(u.searchParams.get('scope')).toBe('identify'); expect(u.searchParams.get('redirect_uri')).toBe('https://example.test/auth/discord/callback'); expect(u.searchParams.get('state')).toBe('browser-bound-state');
    expect(await oauth.identify('fake-code')).toBe('222222222222222222'); expect(calls).toHaveLength(2); expect(String(calls[0]?.init.body)).toContain('grant_type=authorization_code'); expect(calls[0]?.init.redirect).toBe('error');
  });
  it('rejects bad identity and network errors without exposing OAuth tokens or raw errors',async () => {
    const bad = new DiscordOAuth('111111111111111111','fake-client-secret','https://example.test',async () => { throw new Error('fake-client-secret raw server body'); });
    await expect(bad.identify('code')).rejects.toThrow(/^oauth_failed$/);
  });
});
