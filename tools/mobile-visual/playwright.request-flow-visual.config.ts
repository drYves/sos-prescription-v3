import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /request-flow-visual-assertions\.spec\.ts/,
  timeout: 90_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'https://sosprescription.fr',
    ignoreHTTPSErrors: true,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'local-chromium',
      use: {
        browserName: 'chromium',
      },
    },
    {
      name: 'local-webkit',
      use: {
        browserName: 'webkit',
      },
    },
  ],
});
