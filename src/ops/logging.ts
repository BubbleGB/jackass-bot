const events = new Set(['runtime_starting','runtime_ready','runtime_stopping','runtime_stopped','runtime_failed','worker_lost','maintenance_failed','guild_reconcile_failed','delivery','shutdown_forced','runtime_error']);
type Event = 'runtime_starting' | 'runtime_ready' | 'runtime_stopping' | 'runtime_stopped' | 'runtime_failed' | 'worker_lost' | 'maintenance_failed' | 'guild_reconcile_failed' | 'delivery' | 'shutdown_forced' | 'runtime_error';
const states = new Set(['delivered','failed','uncertain','blocked']);
export function safeLogger(sink: (line: string) => void = line => { process.stdout.write(line+'\n'); },now: () => Date = () => new Date()) {
  return (event: Event,state?: 'delivered' | 'failed' | 'uncertain' | 'blocked') => {
    try { sink(JSON.stringify({ at: now().toISOString(),event: events.has(event) ? event : 'runtime_error',...(state && states.has(state) ? { state } : {}) })); } catch { /* Logging cannot destabilize cleanup or expose a raw error. */ }
  };
}
export type RuntimeLogger = ReturnType<typeof safeLogger>;
