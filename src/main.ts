import { loadConfig } from './config.js';

// Task 1 validates configuration only. No Discord, provider or database startup.
try {
  const config = loadConfig(process.env);
  if (config.mode !== 'foundation') throw new Error('Runtime startup is unavailable until Task 8');
  console.info('Galaxy Neegy foundation configuration is valid. No services started.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Configuration validation failed');
  process.exitCode = 1;
}
