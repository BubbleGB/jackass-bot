import { describe,it,expect,vi } from 'vitest';
import { resolveSecrets } from '../../src/ops/secrets.js';
import { RuntimeHealth } from '../../src/ops/health.js';
import { safeLogger } from '../../src/ops/logging.js';
import { spawnSync } from 'node:child_process';
describe('runtime safety contracts',() => {
  it.each(['queueMicrotask(() => { throw new Error("private-runtime-key conversation text"); })','Promise.reject(new Error("private-runtime-key conversation text"))'])('sanitises a fatal process boundary and exits unsuccessfully (%s)',source => {
    const module = new URL('../../src/ops/process.ts',import.meta.url).href;
    const result = spawnSync(process.execPath,['--input-type=module','-e',`import { installProcessSafety } from ${JSON.stringify(module)}; installProcessSafety(() => { console.log('runtime_error'); process.exitCode = 1; }); ${source}`],{ encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stdout).toContain('runtime_error'); expect(result.stderr).toBe(''); expect(result.stdout).not.toMatch(/private-runtime-key|conversation text/);
  });
  it('loads explicit mounted secrets without putting paths or contents in failures',async () => {
    const e = await resolveSecrets({ DISCORD_BOT_TOKEN_FILE: '/private/path' },async () => 'fake-bot-secret\n'); expect(e.DISCORD_BOT_TOKEN).toBe('fake-bot-secret');
    await expect(resolveSecrets({ DISCORD_BOT_TOKEN: 'fake-secret',DISCORD_BOT_TOKEN_FILE: '/private/path' },async () => '')).rejects.toThrow('Invalid secret configuration: DISCORD_BOT_TOKEN');
    try { await resolveSecrets({ DATABASE_URL_FILE: '/private-secret-path' },async () => { throw new Error('private-db-password'); }); } catch (e) { expect(String(e)).not.toMatch(/private-secret-path|private-db-password/); }
  });
  it('does not report ready before startup, during disconnect, after failure or during stop',async () => {
    let connected = true,probes = 0; const h = new RuntimeHealth(() => connected,async () => { probes++; });
    expect(await h.ready()).toBe(false); h.phase = 'running'; expect(await h.ready()).toBe(true); expect(probes).toBe(1);
    connected = false; expect(await h.ready()).toBe(false); connected = true; h.phase = 'stopping'; expect(await h.ready()).toBe(false);
  });
  it('bounds and coalesces hung readiness probes',async () => {
    vi.useFakeTimers();
    try { let probes = 0; const h = new RuntimeHealth(() => true,async () => { probes++; await new Promise<void>(() => undefined); }); h.phase = 'running'; const a = h.ready(),b = h.ready(); await vi.advanceTimersByTimeAsync(1600); expect(await a).toBe(false); expect(await b).toBe(false); expect(probes).toBe(1); const c = h.ready(); await vi.advanceTimersByTimeAsync(1600); expect(await c).toBe(false); expect(probes).toBe(1); }
    finally { vi.useRealTimers(); }
  });
  it('serializes only allowlisted events and delivery states, never arbitrary errors or payloads',() => {
    const lines: string[] = [],log = safeLogger(s => { lines.push(s); });
    log('runtime_ready'); log('fake-api-key conversation text' as never,'private-token' as never); log('delivery','uncertain');
    expect(lines.join('')).not.toMatch(/fake-api-key|conversation text|private-token/); expect(lines.join('')).toContain('runtime_error'); expect(lines.join('')).toContain('uncertain');
  });
});
