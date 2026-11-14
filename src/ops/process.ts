/** A fatal process error must stop the runtime without Node printing raw exceptions. */
export function installProcessSafety(fatal: () => void): () => void {
  let failed = false;
  const stop = () => { if (!failed) { failed = true; fatal(); } };
  process.on('uncaughtException',stop); process.on('unhandledRejection',stop);
  return () => { process.removeListener('uncaughtException',stop); process.removeListener('unhandledRejection',stop); };
}
