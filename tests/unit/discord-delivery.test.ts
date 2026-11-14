import { describe,it,expect } from 'vitest';
import { DiscordDelivery,splitAnswer } from '../../src/discord/delivery.js';
import { DiscordFailure,type DiscordCall } from '../../src/discord/transport.js';
const body = (r: DiscordCall) => r.body as Record<string,unknown>;
import { request,user,channel } from '../helpers/conversation.js';
describe('Discord output and bounded delivery',() => {
  it('neutralizes mass/role/fabricated mentions and permits only three supplied human participants on every chunk',async () => {
    const calls: DiscordCall[] = [];
    const delivery = new DiscordDelivery({ async call(r) { calls.push(r); return { id: String(calls.length) }; } },async () => true);
    const ids = [user,channel,'666666666666666666','777777777777777777'];
    const text = `@everyone @here <@&${user}> <@888888888888888888> <@${user}> `+'long '.repeat(900);
    const result = await delivery.deliverAnswer(request,text,ids);
    expect(result.state).toBe('delivered'); expect(calls.length).toBeGreaterThan(1);
    for (const r of calls) {
      expect(body(r).allowed_mentions).toEqual({ parse: [],roles: [],users: ids.slice(0,3),replied_user: false });
      expect(body(r).content).not.toMatch(/@everyone|@here|<@&|<@888888888888888888>/);
      expect(String(body(r).content).length).toBeLessThanOrEqual(2000);
    }
    expect(body(calls[0]!).message_reference).toMatchObject({ message_id: request.id,fail_if_not_exists: false });
  });
  it('splits Unicode and escaped Markdown without dangling escapes or half surrogate pairs',() => {
    const chunks = splitAnswer('```ts\n'+('**😀**\\\n'.repeat(1000))+'```');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) { expect(chunk.length).toBeLessThanOrEqual(2000); expect(chunk).not.toMatch(/(?<!\\)(?:\\\\)*\\$/); expect(chunk.isWellFormed()).toBe(true); expect(chunk).not.toContain('```'); }
  });
  it('retries known not-sent and rate-limited attempts without replaying delivered chunks',async () => {
    const calls: DiscordCall[] = []; const waits: number[] = [];
    const delivery = new DiscordDelivery({ async call(r) { calls.push(r); if (calls.length === 2) throw new DiscordFailure('retryable',10); if (calls.length === 3) throw new DiscordFailure('rate_limited',20); return { id: String(calls.length) }; } },async () => true,{ delay: async ms => { waits.push(ms); } });
    const result = await delivery.deliverAnswer(request,'x'.repeat(2500),[]);
    expect(result.state).toBe('delivered'); expect(waits).toEqual([10,20]); expect(body(calls[0]!).content).not.toBe(body(calls[1]!).content); expect(calls[1]!.body).toEqual(calls[2]!.body); expect(calls[2]!.body).toEqual(calls[3]!.body);
  });
  it('stops at an uncertain later chunk and preserves known progress without retrying',async () => {
    let calls = 0;
    const delivery = new DiscordDelivery({ async call() { if (++calls === 2) throw new Error('private token lost acknowledgement'); return { id: 'delivered-first' }; } },async () => true);
    const result = await delivery.deliverAnswer(request,'x'.repeat(2500),[]);
    expect(result).toMatchObject({ state: 'uncertain',deliveredMessageIds: ['delivered-first'],nextChunk: 1 }); expect(calls).toBe(2); expect(JSON.stringify(result)).not.toContain('private');
  });
  it('cancels an in-flight send on worker revocation without replaying or sending later chunks',async () => {
    const controller = new AbortController(); let sends = 0,sendSignal: AbortSignal | undefined;
    const delivery = new DiscordDelivery({ async call(r) { sends++; sendSignal = r.signal; controller.abort(); return new Promise<never>(() => undefined); } },async () => true,{ signal: controller.signal });
    const result = await delivery.deliverAnswer(request,'x'.repeat(2500),[]);
    expect(result.state).toBe('uncertain'); expect(result.deliveredMessageIds).toHaveLength(0); expect(sends).toBe(1); expect(sendSignal?.aborted).toBe(true);
  });
  it('bounds attempts, respects long retry delays and fails closed on permission loss',async () => {
    let calls = 0;
    const delivery = new DiscordDelivery({ async call() { calls++; throw new DiscordFailure('retryable',0); } },async () => true,{ delay: async () => undefined });
    expect((await delivery.deliverAnswer(request,'Hi',[])).state).toBe('failed'); expect(calls).toBe(3);
    calls = 0;
    const blocked = new DiscordDelivery({ async call() { calls++; return { id: 'bad' }; } },async () => false);
    expect((await blocked.deliverAnswer(request,'Hi',[])).state).toBe('blocked'); expect(calls).toBe(0);
    const limited = new DiscordDelivery({ async call() { calls++; throw new DiscordFailure('rate_limited',5000); } },async () => true);
    expect((await limited.deliverAnswer(request,'Hi',[])).state).toBe('failed'); expect(calls).toBe(1);
  });
});
