import { describe,it,expect,vi } from 'vitest';
import { DiscordRest,DiscordFailure } from '../../src/discord/transport.js';
describe('single-attempt Discord REST transport',() => {
  it('removes timed-out queued reads before they can reach HTTP and recovers on the next request',async () => {
    vi.useFakeTimers();
    try {
      let requests = 0;
      const rest = new DiscordRest('fake-secret',async () => { requests++; return new Response('{}',{ headers: { 'x-ratelimit-remaining': '0','x-ratelimit-reset-after': '6' } }); });
      const path = '/guilds/111111111111111111/roles'; await rest.call({ method: 'GET',path });
      const a = new AbortController(),b = new AbortController();
      const first = rest.call({ method: 'GET',path,signal: a.signal }),second = rest.call({ method: 'GET',path,signal: b.signal });
      const assertions = Promise.all([expect(first).rejects.toMatchObject({ kind: 'uncertain' }),expect(second).rejects.toMatchObject({ kind: 'uncertain' })]);
      await vi.advanceTimersByTimeAsync(5000); a.abort(); b.abort(); await assertions;
      await vi.advanceTimersByTimeAsync(1100); expect(requests).toBe(1);
      await rest.call({ method: 'GET',path }); expect(requests).toBe(2);
    } finally { vi.useRealTimers(); }
  });
  it('bounds repeated 429 reads to three HTTP attempts',async () => {
    vi.useFakeTimers();
    try {
      let requests = 0;
      const rest = new DiscordRest('fake-secret',async () => { requests++; return new Response('{"retry_after":0.1}',{ status: 429 }); });
      const assertion = expect(rest.call({ method: 'GET',path: '/guilds/111111111111111111/roles' })).rejects.toMatchObject({ kind: 'rate_limited' });
      await vi.advanceTimersByTimeAsync(400); await assertion; expect(requests).toBe(3);
    } finally { vi.useRealTimers(); }
  });
  it('honours a global 429 before a read to another route',async () => {
    vi.useFakeTimers();
    try {
      const paths: string[] = [];
      const rest = new DiscordRest('fake-secret',async url => { paths.push(String(url)); return paths.length === 1 ? new Response('{"retry_after":0.2,"global":true}',{ status: 429 }) : new Response('{}'); });
      const first = rest.call({ method: 'GET',path: '/guilds/111111111111111111/roles' }); await vi.advanceTimersByTimeAsync(10);
      const second = rest.call({ method: 'GET',path: '/guilds/111111111111111111/channels' }); await vi.advanceTimersByTimeAsync(100); expect(paths).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(200); await Promise.all([first,second]); expect(paths).toHaveLength(3);
    } finally { vi.useRealTimers(); }
  });
  it('queues GETs behind a documented bucket reset without issuing another HTTP request early',async () => {
    vi.useFakeTimers();
    try {
      let requests = 0;
      const rest = new DiscordRest('fake-secret',async () => { requests++; return new Response('{}',{ headers: { 'x-ratelimit-remaining': '0','x-ratelimit-reset-after': '1' } }); });
      await rest.call({ method: 'GET',path: '/guilds/111111111111111111/roles' });
      const work = rest.call({ method: 'GET',path: '/guilds/111111111111111111/roles' });
      await vi.advanceTimersByTimeAsync(500); expect(requests).toBe(1);
      await vi.advanceTimersByTimeAsync(600); await work; expect(requests).toBe(2);
    } finally { vi.useRealTimers(); }
  });
  it('retries a read after a Discord 429, but never replays writes',async () => {
    vi.useFakeTimers();
    try {
      let requests = 0;
      const rest = new DiscordRest('fake-secret',async () => ++requests === 1 ? new Response('{"retry_after":0.1}',{ status: 429 }) : new Response('{"ok":true}'));
      const work = rest.call({ method: 'GET',path: '/guilds/111111111111111111/roles' });
      const assertion = expect(work).resolves.toEqual({ ok: true }); await vi.advanceTimersByTimeAsync(200); await assertion; expect(requests).toBe(2);
    } finally { vi.useRealTimers(); }
  });
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
