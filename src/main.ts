import { loadConfig } from './config.js';
import { resolveSecrets } from './ops/secrets.js';
import { safeLogger } from './ops/logging.js';
import { startApplication } from './runtime/application.js';
import { installProcessSafety } from './ops/process.js';
const log = safeLogger(),controller = new AbortController();
const removeSafety = installProcessSafety(() => { log('runtime_error'); process.exitCode = 1; controller.abort(); });
let booted = false;
let deadline: ReturnType<typeof setTimeout> | undefined;
const signal = () => controller.abort();
process.once('SIGTERM',signal); process.once('SIGINT',signal);
controller.signal.addEventListener('abort',() => { deadline = setTimeout(() => { log('shutdown_forced'); process.exit(1); },115000); deadline.unref(); },{ once: true });
try {
  const config = loadConfig(await resolveSecrets(process.env));
  if (config.mode === 'foundation') console.info('Galaxy Neegy foundation configuration is valid. No services started.');
  else {
    const stopped = new Promise<void>(resolve => { if (controller.signal.aborted) resolve(); else controller.signal.addEventListener('abort',() => resolve(),{ once: true }); });
    const app = await startApplication(config,{ signal: controller.signal,onFatal: () => { process.exitCode = 1; controller.abort(); } });
    booted = true; await stopped; await app.stop();
  }
} catch { if (booted || !controller.signal.aborted) { log('runtime_failed'); process.exitCode = 1; } }
finally { clearTimeout(deadline); removeSafety(); process.removeListener('SIGTERM',signal); process.removeListener('SIGINT',signal); }
// Failed cleanup must not leave an SDK handle keeping an unhealthy process alive.
if (process.exitCode) process.exit(1);
