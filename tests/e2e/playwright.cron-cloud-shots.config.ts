import { defineConfig } from '@playwright/test';
import base from './playwright.e2e.config';

// Dedicated deterministic renderer shots: bundled Chromium, no real model or cloud API.
export default defineConfig(base, {
  testMatch: ['**/cronCloudUnconfiguredScheduleShots.ts'],
  outputDir: '../../test-results/cron-cloud-unconfigured-run',
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { headless: true, channel: undefined, video: 'off' },
});
