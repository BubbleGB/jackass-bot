import { defineConfig } from 'drizzle-kit';
// Generation is offline. Migrations are an explicit operation using the built runner.
export default defineConfig({ dialect: 'postgresql', schema: './src/db/schema.ts', out: './drizzle', strict: true, verbose: true });
