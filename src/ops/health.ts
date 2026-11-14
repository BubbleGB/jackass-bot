import type { FastifyInstance } from 'fastify';
export class RuntimeHealth {
  phase: 'starting' | 'running' | 'stopping' | 'failed' | 'stopped' = 'starting';
  private probe: Promise<boolean> | null = null;
  constructor(private readonly connected: () => boolean,private readonly check: () => Promise<void>) {}
  async ready(): Promise<boolean> {
    if (this.phase !== 'running' || !this.connected()) return false;
    if (!this.probe) {
      let timer: ReturnType<typeof setTimeout>;
      const work = Promise.resolve().then(this.check).then(() => true,() => false);
      this.probe = Promise.race([work,new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false),1500); })]);
      // A timeout bounds HTTP latency, not the underlying DB call. Keep coalescing
      // until that call settles so repeated probes cannot create an unbounded queue.
      void work.then(() => { clearTimeout(timer); this.probe = null; });
    }
    const valid = await this.probe; return valid && this.phase === 'running' && this.connected();
  }
}
export function registerHealth(app: FastifyInstance,health: RuntimeHealth): void {
  app.get('/health/live',async () => ({ status: 'alive' }));
  app.get('/health/ready',async (_r,reply) => { const ready = await health.ready(); return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready' }); });
}
