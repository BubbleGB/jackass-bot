interface Waiting { start: () => void; cancel: () => void }
interface Bucket { busy: boolean; waiting: Waiting[]; until: number; cleanup?: ReturnType<typeof setTimeout> }
/** GET-only route scheduling, not a permission cache. Deadlines include queue time. */
export class DiscordReadQueue {
  private readonly buckets = new Map<string,Bucket>();
  private globalUntil = 0;
  key(path: string): string { return path.split('?')[0]!.replace(/\/(members|messages)\/\d{17,20}/g,'/$1/:id'); }
  limit(key: string,ms: number,global = false): void {
    const until = Date.now()+ms+25; // Small scheduling margin; not a Discord guarantee.
    if (global) this.globalUntil = Math.max(this.globalUntil,until);
    else { const b = this.buckets.get(key); if (b) b.until = Math.max(b.until,until); }
  }
  async run<T>(key: string,signal: AbortSignal,work: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new Error('discord_cancelled');
    let bucket = this.buckets.get(key);
    if (!bucket) { bucket = { busy: false,waiting: [],until: 0 }; this.buckets.set(key,bucket); }
    const b = bucket; clearTimeout(b.cleanup);
    if (b.waiting.length >= 128) throw new Error('discord_queue_full');
    return new Promise<T>((resolve,reject) => {
      const entry: Waiting = { start: () => {
        signal.removeEventListener('abort',entry.cancel); b.busy = true;
        void work().then(resolve,reject).finally(() => { b.busy = false; this.next(key,b); });
      },cancel: () => { const i = b.waiting.indexOf(entry); if (i >= 0) b.waiting.splice(i,1); signal.removeEventListener('abort',entry.cancel); reject(new Error('discord_cancelled')); } };
      signal.addEventListener('abort',entry.cancel,{ once: true }); b.waiting.push(entry); this.next(key,b);
    });
  }
  private next(key: string,b: Bucket): void {
    if (b.busy) return;
    const entry = b.waiting.shift(); if (entry) { entry.start(); return; }
    const remaining = b.until-Date.now();
    if (remaining > 0) { b.cleanup = setTimeout(() => this.next(key,b),Math.min(remaining,60000)); b.cleanup.unref(); }
    else this.buckets.delete(key);
  }
  async ready(key: string,signal: AbortSignal): Promise<void> {
    while (true) {
      if (signal.aborted) throw new Error('discord_cancelled');
      const ms = Math.max(this.globalUntil,this.buckets.get(key)?.until ?? 0)-Date.now(); if (ms <= 0) return;
      await new Promise<void>((resolve,reject) => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort',abort); resolve(); };
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort',abort); reject(new Error('discord_cancelled')); };
        const timer = setTimeout(finish,Math.min(ms,60000)); signal.addEventListener('abort',abort,{ once: true }); if (signal.aborted) abort();
      });
    }
  }
}
