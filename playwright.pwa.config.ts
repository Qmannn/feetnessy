import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-pwa',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4173',
    browserName: 'chromium',
    viewport: { width: 393, height: 851 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run preview -- --host localhost --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
  },
});
