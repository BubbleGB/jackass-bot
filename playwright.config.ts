import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/e2e',workers: 1,fullyParallel: false,timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:4173',trace: 'retain-on-failure',screenshot: 'only-on-failure' },
  projects: [{ name: 'android-390',use: { browserName: 'chromium',viewport: { width: 390,height: 844 },isMobile: true,hasTouch: true } },{ name: 'desktop',use: { browserName: 'chromium',viewport: { width: 1440,height: 1000 } } }],
  webServer: { command: 'npm run test:e2e:server',url: 'http://127.0.0.1:4173/api/site',reuseExistingServer: false,timeout: 60000 },
});
