import { defineConfig } from '@playwright/test';
// Browser scenarios arrive with the dashboard in Task 7. No false passing empty suite.
export default defineConfig({ testDir: './tests/e2e', use: { viewport: { width: 390, height: 844 } } });
