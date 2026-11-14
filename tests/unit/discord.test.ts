import { describe,it,expect,vi } from 'vitest';
import { DiscordHandlers } from '../../src/discord/events.js';
import { DiscordFailure,type DiscordCall } from '../../src/discord/transport.js';
import { request,guild,channel,user,instant } from '../helpers/conversation.js';
import type { DirectOutcome } from '../../src/conversation/direct.js';
import { SettingsError } from '../../src/access/policy.js';
const interaction = { id: request.id,applicationId: '999999999999999999',token: 'fake-interaction-token',guildId: guild,channelId: channel,userId: user,channelType: 0,command: 'ask',prompt: 'Hi' };
function fixture() {
  const calls: DiscordCall[] = [],trace: string[] = []; let denied = false;
  let fail: ((r: DiscordCall) => boolean) | undefined;
  let run: () => Promise<DirectOutcome> = async () => ({ status: 'accepted' as const,result: { kind: 'answer' as const,text: 'Hello',usage: { inputTokens: 1,outputTokens: 1,reasoningTokens: 0,totalTokens: 2,certainty: 'reported' as const } },participantIds: [user] });
  const transport = { async call(r: DiscordCall) { calls.push(r); trace.push(r.path.endsWith('/callback') ? 'ack' : 'discord'); if (fail?.(r)) throw new DiscordFailure('uncertain'); return { id: String(calls.length) }; } };
  const handlers = new DiscordHandlers({ transport,publicOrigin: 'https://example.test',now: () => instant,
    worker: { async observeMessage() { trace.push('observe'); return 'counted' as const; },async submitDirect() { trace.push('provider'); return run(); } },
    access: { async require() { trace.push('access'); if (denied) throw new SettingsError('forbidden'); return 'admin' as const; } },
    status: { async getUsageStatus() { return { resetAt: '2026-11-15T00:00:00Z',providers: [] }; } },canDeliver: async () => true,
  });
  return { handlers,calls,trace,failWhen(f: (r: DiscordCall) => boolean) { fail = f; },setDenied() { denied = true; },setRun(value: typeof run) { run = value; } };
}
describe('Discord command and event handlers',() => {
  it('acknowledges /ask publicly before slow services then edits a public safe answer',async () => {
    const f = fixture(); await f.handlers.handleInteraction(interaction);
    expect(f.trace[0]).toBe('ack'); expect(f.trace.indexOf('provider')).toBeGreaterThan(0);
    expect(f.calls[0]?.body).toEqual({ type: 5,data: { flags: 0 } });
    const answer = f.calls.find(c => c.method === 'PATCH'); expect(answer?.body).toMatchObject({ content: 'Hello',allowed_mentions: { parse: [],roles: [],users: [user],replied_user: false } });
  });
  it.each(['settings','status'] as const)('defers /%s privately before checking current access and rejects revoked access privately',async command => {
    const f = fixture(); f.setDenied(); await f.handlers.handleInteraction({ ...interaction,command });
    expect(f.calls[0]?.body).toEqual({ type: 5,data: { flags: 64 } }); expect(f.trace.slice(0,2)).toEqual(['ack','access']);
    expect(f.calls.find(c => c.method === 'PATCH')?.body).toMatchObject({ content: expect.stringContaining('access'),allowed_mentions: { users: [],roles: [],parse: [],replied_user: false } }); expect(f.trace).not.toContain('provider');
  });
  it('provides private help with usage and provider privacy, and excludes DM/thread commands',async () => {
    const f = fixture(); await f.handlers.handleInteraction({ ...interaction,command: 'help' });
    expect(JSON.stringify(f.calls)).toContain('OpenAI'); expect(JSON.stringify(f.calls)).toContain('Google'); expect(JSON.stringify(f.calls)).toMatch(/recent/i); expect(f.trace).not.toContain('provider');
    await f.handlers.handleInteraction({ ...interaction,channelType: 11 }); expect(f.calls.at(-1)?.body).toMatchObject({ content: expect.stringContaining('server text channel') });
  });
  it('removes the public placeholder and gives a private cooldown notice without a public cooldown message',async () => {
    const f = fixture(); f.setRun(async () => ({ status: 'cooldown' })); await f.handlers.handleInteraction(interaction);
    expect(f.calls.some(c => c.method === 'DELETE')).toBe(true);
    expect(f.calls.at(-1)?.body).toMatchObject({ flags: 64,content: expect.stringContaining('cooldown') });
    const edits = f.calls.filter(c => c.method === 'PATCH');
    expect(edits.length).toBeGreaterThan(0); expect(JSON.stringify(edits)).not.toContain('cooldown');
    expect(f.calls.findIndex(c => c.method === 'PATCH')).toBeLessThan(f.calls.findIndex(c => c.method === 'DELETE'));
  });
  it('acknowledges unavailable requests even when their public channel notice is suppressed',async () => {
    const f = fixture(); f.setRun(async () => { throw new Error('private provider failure'); });
    await f.handlers.handleInteraction(interaction); await f.handlers.handleInteraction({ ...interaction,id: '555555555555555556' });
    expect(f.calls.filter(c => c.path.endsWith('/callback'))).toHaveLength(2); expect(f.calls.at(-1)?.body).toMatchObject({ flags: 64 });
    expect(JSON.stringify(f.calls)).not.toContain('private provider failure');
  });
  it('does not start provider work after an unconfirmed interaction acknowledgement',async () => {
    const f = fixture(); f.failWhen(c => c.path.endsWith('/callback')); await f.handlers.handleInteraction(interaction);
    expect(f.trace).toEqual(['ack']); expect(f.calls).toHaveLength(1);
  });
  it('does not mutate or repeat an unconfirmed first slash answer',async () => {
    const f = fixture(); f.failWhen(c => c.method === 'PATCH'); await f.handlers.handleInteraction(interaction);
    expect(f.calls.map(c => c.method)).toEqual(['POST','PATCH']); expect(f.trace.filter(t => t === 'provider')).toHaveLength(1);
  });
  it('preserves the confirmed original slash chunk when a later chunk is uncertain',async () => {
    const f = fixture(); f.setRun(async () => ({ status: 'accepted',result: { kind: 'answer',text: 'x'.repeat(2500),usage: { inputTokens: 1,outputTokens: 1,reasoningTokens: 0,totalTokens: 2,certainty: 'reported' } } }));
    f.failWhen(c => c.method === 'POST' && c.path.includes('/webhooks/'));
    await f.handlers.handleInteraction(interaction);
    expect(f.calls.filter(c => c.method === 'PATCH')).toHaveLength(1); expect(f.calls.some(c => c.method === 'DELETE')).toBe(false);
    expect(f.trace.filter(t => t === 'provider')).toHaveLength(1);
    expect(f.calls.at(-1)?.body).toMatchObject({ flags: 64 });
  });
  it.each(['answer','silence','refusal','failure','cooldown','busy'] as const)('stops typing refresh through the %s outcome handler',async kind => {
    vi.useFakeTimers();
    try {
      const f = fixture(); f.handlers.beginTyping(request); await vi.advanceTimersByTimeAsync(0);
      if (kind === 'failure') await f.handlers.handleOutcome(request,{ kind: 'skipped',reason: 'providers_unavailable' });
      else if (kind === 'cooldown' || kind === 'busy') await f.handlers.handleOutcome(request,{ kind: 'direct',outcome: { status: kind } });
      else await f.handlers.handleOutcome(request,{ kind: 'direct',outcome: { status: 'accepted',participantIds: [user],result: kind === 'silence' ? { kind,usage: { inputTokens: 1,outputTokens: 0,reasoningTokens: 0,totalTokens: 1,certainty: 'reported' } } : { kind,text: 'safe',usage: { inputTokens: 1,outputTokens: 0,reasoningTokens: 0,totalTokens: 1,certainty: 'reported' } } } });
      const before = f.calls.filter(c => c.path.endsWith('/typing')).length; await vi.advanceTimersByTimeAsync(16000);
      expect(f.calls.filter(c => c.path.endsWith('/typing')).length).toBe(before); f.handlers.stop();
    } finally { vi.useRealTimers(); }
  });
  it('stops typing refresh on completion/failure and never refreshes /ask typing',async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); f.handlers.beginTyping(request); await vi.advanceTimersByTimeAsync(16000);
      expect(f.calls.filter(c => c.path.endsWith('/typing')).length).toBe(3);
      f.handlers.endTyping(request); await vi.advanceTimersByTimeAsync(16000); expect(f.calls.filter(c => c.path.endsWith('/typing')).length).toBe(3);
      f.handlers.beginTyping({ ...request,source: 'ask',prompt: 'Hi' }); await vi.advanceTimersByTimeAsync(8000); expect(f.calls.filter(c => c.path.endsWith('/typing')).length).toBe(3); f.handlers.stop();
    } finally { vi.useRealTimers(); }
  });
});
