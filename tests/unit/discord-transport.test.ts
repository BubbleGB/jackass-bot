import { describe,it,expect,vi } from 'vitest';
import { DiscordRest,DiscordFailure } from '../../src/discord/transport.js';
describe('single-attempt Discord REST transport',() => {
  it('honors rate-limit seconds and conservatively stops when the retry delay is absent',async () => {
    let count = 0;
    const rest = new DiscordRest('fake-secret',async () => { count++; return new Response('{}',{ status: 429 }); });
    await expect(rest.call({ method: 'POST',path: '/channels/1/messages' })).rejects.toMatchObject({ kind: 'rate_limited',retryAfterMs: 60000 });
    expect(count).toBe(1);
    const limited = new DiscordRest('fake-secret',async () => new Response('{"retry_after":1.25}',{ status: 429 }));
    await expect(limited.call({ method: 'POST',path: '/channels/1/messages' })).rejects.toMatchObject({ kind: 'rate_limited',retryAfterMs: 1250 });
  });
  it.each([408,500,502])('classifies HTTP %s as uncertain without automatic replay',async status => {
    let count = 0;
    const rest = new DiscordRest('fake-secret',async () => { count++; return new Response('private response text',{ status }); });
    await expect(rest.call({ method: 'POST',path: '/channels/1/messages' })).rejects.toMatchObject({ kind: 'uncertain',message: 'discord_uncertain' }); expect(count).toBe(1);
  });
  it('bounds a hanging transport and removes raw network errors and secrets',async () => {
    const broken = new DiscordRest('fake-secret',async () => { throw new Error('fake-secret with private response text'); });
    try { await broken.call({ method: 'POST',path: '/channels/1/messages' }); throw new Error('expected failure'); }
    catch (e) { expect(e).toBeInstanceOf(DiscordFailure); expect(String(e)).toBe('DiscordFailure: discord_uncertain'); expect(JSON.stringify(e)).not.toMatch(/fake-secret|private response/); }
    vi.useFakeTimers();
    try {
      const hanging = new DiscordRest('fake-secret',async () => new Promise<Response>(() => undefined));
      const controller = new AbortController(),work = hanging.call({ method: 'POST',path: '/channels/1/messages',signal: controller.signal });
      const assertion = expect(work).rejects.toMatchObject({ kind: 'uncertain' }); controller.abort(); await assertion;
    } finally { vi.useRealTimers(); }
  });
});
