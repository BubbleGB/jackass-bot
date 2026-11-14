import { describe,it,expect } from 'vitest';
import { ConversationQueue } from '../../src/conversation/queue.js';
import { request,instant } from '../helpers/conversation.js';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise,resolve }; }
const job = (n: number,source: 'ask' | 'automatic' = 'automatic') => ({ ...request,id: String(BigInt(request.id)+BigInt(n)),channelId: String(BigInt(request.channelId)+BigInt(n)),source,...(source === 'ask' ? { prompt: 'Hi' } : {}) });
describe('bounded shared conversation queue',() => {
  it('runs two channels globally while preserving same-channel order and no overlap',async () => {
    const q = new ConversationQueue(() => instant),first = deferred(),second = deferred(),trace: string[] = [];
    q.enqueue(job(1),async () => { trace.push('a1'); await first.promise; });
    q.enqueue({ ...job(2),channelId: job(1).channelId },async () => { trace.push('a2'); });
    q.enqueue(job(3),async () => { trace.push('b1'); await second.promise; });
    await flush(); expect(trace).toEqual(['a1','b1']); first.resolve(); await flush(); expect(trace).toEqual(['a1','b1','a2']); second.resolve(); await q.idle();
  });
  it('limits waiting work to ten per channel and 100 globally, excluding active work',async () => {
    const q = new ConversationQueue(() => instant),hold = deferred(); q.enqueue(job(1),() => hold.promise); await flush();
    for (let n = 0; n < 10; n++) expect(q.enqueue(job(1),async () => undefined)).toBe('accepted');
    expect(q.enqueue(job(1),async () => undefined)).toBe('full');
    for (let n = 2; n <= 91; n++) expect(q.enqueue(job(n),async () => undefined)).toBe('accepted');
    expect(q.enqueue(job(92),async () => undefined)).toBe('full'); q.close(); hold.resolve(); await q.idle();
  });
  it('prioritizes direct channel heads without starving automatic heads or reordering a channel',async () => {
    const q = new ConversationQueue(() => instant),hold = deferred(),trace: string[] = [];
    q.enqueue(job(1),() => hold.promise); q.enqueue(job(2),() => hold.promise); await flush();
    q.enqueue(job(3),async () => { trace.push('auto'); });
    for (let n = 4; n < 10; n++) q.enqueue(job(n,'ask'),async () => { trace.push('direct'); });
    hold.resolve(); await q.idle(); expect(trace.slice(0,4)).toEqual(['direct','direct','direct','auto']);
  });
  it('drops jobs stale after 30 seconds at dispatch and never invokes them',async () => {
    let time = instant.getTime(); const q = new ConversationQueue(() => new Date(time)),hold = deferred(); let calls = 0;
    q.enqueue(job(1),() => hold.promise); q.enqueue(job(2),() => hold.promise); await flush();
    const waiting = q.submit(job(3),async () => { calls++; }).catch(e => e.message);
    time += 30000; await flush(); expect(calls).toBe(0); hold.resolve(); await q.idle(); expect(await waiting).toBe('request_stale'); expect(calls).toBe(0);
  });
  it('cleans failed work, drains active work and rejects queued/new jobs after stop',async () => {
    const q = new ConversationQueue(() => instant),hold = deferred();
    const a = q.submit(job(1),async () => { await hold.promise; throw new Error('fake private failure'); }).catch(() => 'failed');
    q.enqueue(job(2),() => hold.promise); await flush();
    const b = q.submit(job(3),async () => undefined).catch(e => e.message); q.close();
    expect(await b).toBe('worker_stopped'); expect(q.enqueue(job(4),async () => undefined)).toBe('full'); hold.resolve(); await q.idle(); expect(await a).toBe('failed');
  });
});
