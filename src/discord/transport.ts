import { DiscordReadQueue } from './read-queue.js';
export interface DiscordCall { method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; path: string; body?: unknown; signal?: AbortSignal }
export interface DiscordTransport { call(request: DiscordCall): Promise<unknown> }
export class DiscordFailure extends Error {
  constructor(readonly kind: 'retryable' | 'rate_limited' | 'forbidden' | 'rejected' | 'uncertain' | 'too_long',readonly retryAfterMs = 0) { super(`discord_${kind}`); this.name = 'DiscordFailure'; }
}
export async function discordBounded<T>(run: () => Promise<T>,signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DiscordFailure('uncertain'); let abort!: () => void;
  try { const cancelled = new Promise<never>((_resolve,reject) => { abort = () => reject(new DiscordFailure('uncertain')); signal.addEventListener('abort',abort,{ once: true }); }); return await Promise.race([Promise.resolve().then(run),cancelled]); }
  finally { signal.removeEventListener('abort',abort); }
}
/** Fixed-host REST. Bounded rate-aware reads; writes remain single-attempt. */
export class DiscordRest implements DiscordTransport {
  private readonly reads = new DiscordReadQueue();
  constructor(private readonly token: string,private readonly fetcher: typeof fetch = fetch) {}
  async call(r: DiscordCall): Promise<unknown> {
    if (!r.path.startsWith('/') || r.path.startsWith('//') || /[\r\n]/.test(r.path)) throw new DiscordFailure('rejected');
    const signal = r.signal ? AbortSignal.any([r.signal,AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
    try {
      if (r.method !== 'GET') return await this.attempt(r,signal);
      const key = this.reads.key(r.path);
      return await this.reads.run(key,signal,async () => {
        for (let attempt = 0; ; attempt++) {
          await this.reads.ready(key,signal);
          try { return await this.attempt(r,signal,key); }
          catch (e) { if (!(e instanceof DiscordFailure) || e.kind !== 'rate_limited' || attempt >= 2) throw e; }
        }
      });
    } catch (e) { if (e instanceof DiscordFailure) throw e; throw new DiscordFailure('uncertain'); }
  }
  private async attempt(r: DiscordCall,signal: AbortSignal,key?: string): Promise<unknown> {
    try {
      const response = await discordBounded(() => this.fetcher(`https://discord.com/api/v10${r.path}`,{ method: r.method,headers: { authorization: `Bot ${this.token}`,'content-type': 'application/json' },...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }),signal,redirect: 'error' }),signal);
      if (response.status === 204) return null;
      const text = await discordBounded(() => response.text(),signal);
      if (Buffer.byteLength(text) > 2097152) throw new DiscordFailure('uncertain');
      let body: unknown; try { body = JSON.parse(text); } catch { body = null; }
      const reset = Number(response.headers.get('x-ratelimit-reset-after'));
      if (key && response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset >= 0) this.reads.limit(key,reset*1000);
      if (response.status === 429) {
        const b = body as { retry_after?: unknown } | null,header = response.headers.get('retry-after'),seconds = typeof b?.retry_after === 'number' ? b.retry_after : header?.trim() ? Number(header) : NaN;
        const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds*1000 : 60000;
        if (key) this.reads.limit(key,ms,(body as { global?: unknown } | null)?.global === true || response.headers.get('x-ratelimit-global') === 'true');
        throw new DiscordFailure('rate_limited',ms);
      }
      if (response.status === 403 || response.status === 404) throw new DiscordFailure('forbidden');
      if (response.status >= 500 || response.status === 408) throw new DiscordFailure('uncertain');
      if (!response.ok) throw new DiscordFailure('rejected');
      return body;
    } catch (e) { if (e instanceof DiscordFailure) throw e; throw new DiscordFailure('uncertain'); }
  }
}
export const noMentions = () => ({ parse: [] as string[],roles: [] as string[],users: [] as string[],replied_user: false });
