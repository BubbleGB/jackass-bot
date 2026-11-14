import type { BotRequest } from '../domain/types.js';
import { ConversationError,validContextRequest } from './types.js';
export const schedulingLimits = { concurrent: 2,perChannelWaiting: 10,totalWaiting: 100,staleMs: 30000,directBurst: 3 } as const;
type DropReason = 'request_stale' | 'worker_stopped';
interface Job { request: BotRequest; run: () => Promise<unknown>; drop: (reason: DropReason) => void }
/** One queue shared by direct/automatic work; no timer ever starts an assessment. */
export class ConversationQueue {
  private readonly queues = new Map<string,Job[]>();
  private readonly running = new Set<string>();
  private waiting = 0; private directStarts = 0; private scheduled = false; private closed = false;
  private readonly idleWaiters: (() => void)[] = [];
  constructor(private readonly now: () => Date = () => new Date()) {}
  enqueue(request: BotRequest,run: () => Promise<unknown>,drop: (reason: DropReason) => void = () => undefined): 'accepted' | 'full' {
    const key = `${request.guildId}:${request.channelId}`,jobs = this.queues.get(key) ?? [];
    if (this.closed || !validContextRequest(request) || this.waiting >= schedulingLimits.totalWaiting || jobs.length >= schedulingLimits.perChannelWaiting) return 'full';
    jobs.push({ request: structuredClone(request),run,drop }); this.queues.set(key,jobs); this.waiting++; this.schedule(); return 'accepted';
  }
  submit<T>(request: BotRequest,run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve,reject) => {
      const admitted = this.enqueue(request,async () => { try { resolve(await run()); } catch (e) { reject(e); } },reason => reject(new ConversationError(reason)));
      if (admitted === 'full') reject(new ConversationError(this.closed ? 'worker_stopped' : 'queue_full'));
    });
  }
  close(): void {
    this.closed = true;
    for (const jobs of this.queues.values()) for (const job of jobs) job.drop('worker_stopped');
    this.queues.clear(); this.waiting = 0; this.notify();
  }
  async idle(): Promise<void> { if (this.waiting === 0 && this.running.size === 0) return; await new Promise<void>(resolve => this.idleWaiters.push(resolve)); }
  private notify(): void { if (this.waiting === 0 && this.running.size === 0) this.idleWaiters.splice(0).forEach(resolve => resolve()); }
  private schedule(): void { if (!this.scheduled) { this.scheduled = true; queueMicrotask(() => { this.scheduled = false; this.pump(); }); } }
  private pump(): void {
    for (const [key,jobs] of this.queues) {
      const fresh = jobs.filter(job => { if (this.now().getTime()-job.request.receivedAt.getTime() < schedulingLimits.staleMs) return true; this.waiting--; job.drop('request_stale'); return false; });
      if (fresh.length) this.queues.set(key,fresh); else this.queues.delete(key);
    }
    while (!this.closed && this.running.size < schedulingLimits.concurrent) {
      const heads = [...this.queues.entries()].filter(([key,jobs]) => !this.running.has(key) && jobs.length);
      const direct = heads.filter(([,jobs]) => jobs[0]!.request.source !== 'automatic'),automatic = heads.filter(([,jobs]) => jobs[0]!.request.source === 'automatic');
      const selected = (this.directStarts >= schedulingLimits.directBurst && automatic.length ? automatic : direct.length ? direct : automatic)[0];
      if (!selected) break;
      const [key,jobs] = selected,job = jobs.shift()!; this.waiting--; if (!jobs.length) this.queues.delete(key);
      this.directStarts = job.request.source === 'automatic' ? 0 : this.directStarts+1; this.running.add(key);
      void Promise.resolve().then(job.run).catch(() => undefined).finally(() => { this.running.delete(key); this.schedule(); this.notify(); });
    }
    this.notify();
  }
}
