import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolveSecrets } from '../ops/secrets.js';
import { createDatabase } from './index.js';

let url: string | undefined;
try { url = (await resolveSecrets(process.env)).DATABASE_URL; } catch { console.error('Database secret could not be loaded.'); }
if (!url) {
  console.error('DATABASE_URL is required for explicit migrations');
  process.exitCode = 1;
} else {
  const database = createDatabase(url);
  try {
    await migrate(database.db, { migrationsFolder: fileURLToPath(new URL('../../drizzle/', import.meta.url)) });
    console.info('Database migrations applied.');
  } catch {
    // Database errors can contain connection details or SQL parameter values.
    console.error('Database migration failed. Check local connectivity and migration permissions.');
    process.exitCode = 1;
  } finally { await database.close(); }
}
