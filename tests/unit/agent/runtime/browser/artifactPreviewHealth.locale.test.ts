import { beforeEach, expect, it, vi } from 'vitest';
import { runArtifactPreviewHealth } from '../../../../../src/host/agent/runtime/browser/artifactPreviewHealth';

const config = vi.hoisted(() => ({ language: 'zh' }));
vi.mock('../../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: config.language } }) }),
}));
vi.mock('../../../../../src/host/platform', () => ({ app: { getLocale: () => 'en-US' } }));
vi.mock('../../../../../src/host/agent/runtime/browser/inAppArtifactPreviewHealth', () => ({
  runInAppArtifactPreviewHealth: vi.fn(async () => { throw new Error('offline'); }),
  isInAppArtifactPreviewHealthUnavailable: () => false,
}));
vi.mock('../../../../../src/host/agent/runtime/browser/playwrightRuntime', () => ({
  loadPlaywrightChromium: async () => ({ ok: false, error: 'unavailable' }),
}));
vi.mock('../../../../../src/host/services/infra/browserProvider', () => ({
  resolveBrowserProvider: () => ({ provider: 'playwright' }),
}));

beforeEach(() => { config.language = 'zh'; });
it('defaults both fallback and self-started health checks to UI language despite English OS', async () => {
  const zh = await runArtifactPreviewHealth('/tmp/page.html');
  expect(zh.checks).toEqual([
    'artifact preview health 因 in-app browser 不可用：offline 降级到 self-started Chrome',
    'artifact preview health 已跳过：unavailable',
  ]);
  config.language = 'en';
  const en = await runArtifactPreviewHealth('/tmp/page.html');
  expect(en.checks).toEqual([
    'artifact preview health fell back to self-started Chrome because in-app browser unavailable: offline',
    'artifact preview health skipped: unavailable',
  ]);
});
it('keeps explicit options.locale precedence over UI language', async () => {
  const result = await runArtifactPreviewHealth('/tmp/page.html', { locale: 'en' });
  expect(result.checks).toEqual([
    'artifact preview health fell back to self-started Chrome because in-app browser unavailable: offline',
    'artifact preview health skipped: unavailable',
  ]);
});
