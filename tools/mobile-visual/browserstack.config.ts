import { defineConfig } from '@playwright/test';

const username = process.env.BROWSERSTACK_USERNAME;
const accessKey = process.env.BROWSERSTACK_ACCESS_KEY;
const configured = Boolean(username && accessKey);

function browserStackEndpoint(capabilities: Record<string, unknown>): string {
  return `wss://cdp.browserstack.com/playwright?caps=${encodeURIComponent(JSON.stringify({
    ...capabilities,
    'browserstack.username': username,
    'browserstack.accessKey': accessKey,
    'browserstack.project': 'SOS Prescription',
    'browserstack.build': `mobile-visual-${new Date().toISOString().slice(0, 10)}`,
    'browserstack.debug': 'true',
    'browserstack.networkLogs': 'true',
    'browserstack.console': 'errors',
  }))}`;
}

const realDeviceProjects = configured
  ? [
      {
        name: 'bs-iphone-se-safari',
        use: {
          connectOptions: {
            wsEndpoint: browserStackEndpoint({
              browser: 'playwright-webkit',
              os: 'ios',
              os_version: '17',
              device: 'iPhone SE 2022',
              real_mobile: 'true',
            }),
          },
        },
      },
      {
        name: 'bs-iphone-14-safari',
        use: {
          connectOptions: {
            wsEndpoint: browserStackEndpoint({
              browser: 'playwright-webkit',
              os: 'ios',
              os_version: '17',
              device: 'iPhone 14',
              real_mobile: 'true',
            }),
          },
        },
      },
      {
        name: 'bs-iphone-15-pro-max-safari',
        use: {
          connectOptions: {
            wsEndpoint: browserStackEndpoint({
              browser: 'playwright-webkit',
              os: 'ios',
              os_version: '17',
              device: 'iPhone 15 Pro Max',
              real_mobile: 'true',
            }),
          },
        },
      },
      {
        name: 'bs-ipad-safari',
        use: {
          connectOptions: {
            wsEndpoint: browserStackEndpoint({
              browser: 'playwright-webkit',
              os: 'ios',
              os_version: '17',
              device: 'iPad 10th',
              real_mobile: 'true',
            }),
          },
        },
      },
      {
        name: 'bs-pixel-7-chrome',
        use: {
          connectOptions: {
            wsEndpoint: browserStackEndpoint({
              browser: 'chrome',
              os: 'android',
              os_version: '13.0',
              device: 'Google Pixel 7',
              real_mobile: 'true',
            }),
          },
        },
      },
    ]
  : [
      {
        name: 'browserstack-not-configured',
        use: {
          browserName: 'chromium' as const,
        },
      },
    ];

export default defineConfig({
  testDir: '.',
  testMatch: /browserstack-visual\.spec\.ts/,
  timeout: 180_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'https://sosprescription.fr',
    ignoreHTTPSErrors: true,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  projects: realDeviceProjects,
});
