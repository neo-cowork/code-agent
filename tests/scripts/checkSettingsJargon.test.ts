import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareSettingsJargon, findSettingsJargon, scanSettingsJargon } from '../../scripts/ci/check-settings-jargon.mjs';
import table from '../../src/renderer/i18n/settingsTerms.json';
import baseline from '../../scripts/ci/settings-jargon-baseline.json';

describe('settings jargon gate', () => {
  it('checks English-only text, case, plurals and separators with a suggested word', () => {
    for (const text of ['Provider', 'Providers', 'Base URL', 'base-url', 'API Key', 'api-key', 'API \n Key', '{Provider}']) {
      expect(findSettingsJargon(text).some((hit) => hit.mode === 'enforce')).toBe(true);
    }
    expect(findSettingsJargon('模型服务 / 接口地址 / 密钥 /v1 OpenAI Claude')).toEqual([]);
    expect(findSettingsJargon('MCP')[0].mode).toBe('report');
    expect(findSettingsJargon('apiKeyConfigured')).toEqual([]);
  });

  it('skips only verbatim literals the user must copy; a term next to one still counts', () => {
    expect(table.literals).toEqual(['/v1', 'X-API-Key', 'mimo providers login']);
    expect(findSettingsJargon('使用 X-API-Key 头进行认证。')).toEqual([]);
    expect(findSettingsJargon('首次使用前需运行 mimo providers login 完成账号授权。')).toEqual([]);
    expect(findSettingsJargon('X-API-Key 里填 API Key').map((hit) => [hit.term, hit.index])).toEqual([['API Key', 13]]);
    expect(findSettingsJargon('providers login').map((hit) => hit.term)).toEqual(['Provider']);
  });

  it('counts down stock by surface and cannot exempt the models or wizard', () => {
    const row = { surface: 'settings/search', hits: findSettingsJargon('API Key') };
    const stock = [{ surface: row.surface, term: 'API Key', count: 1, reason: 'N-FIX-UI-ENGLISH-JARGON-SWEEP: search stock' }];
    expect(compareSettingsJargon([row], stock)).toEqual([]);
    expect(compareSettingsJargon([{ ...row, hits: findSettingsJargon('API Key API Key') }], stock).join('\n')).toContain('2 > baseline 1; use 密钥');
    expect(compareSettingsJargon([{ ...row, surface: 'models/custom' }], stock)).not.toEqual([]);
    expect(compareSettingsJargon([row], [{ ...stock[0], reason: '' }])).not.toEqual([]);
  });

  it('AST scan catches English-only JSX and locale values while leaving the English bundle alone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-jargon-'));
    try {
      for (const dir of ['src/renderer/i18n', 'src/renderer/components/features/settings', 'src/renderer/components/onboarding']) fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, 'src/renderer/i18n/settingsTerms.json'), JSON.stringify(table));
      fs.writeFileSync(path.join(root, 'src/renderer/i18n/onboarding.ts'), "export const onboardingZh = { label: 'API Key' }; export const onboardingEn = { label: 'Provider' };");
      fs.writeFileSync(path.join(root, 'src/renderer/components/onboarding/NewWizard.tsx'), 'const View = () => <div><label>API Key</label><input title="Provider" placeholder="Base URL" aria-label="Provider" /></div>;');
      const rows = scanSettingsJargon(root);
      expect(rows.find((row) => row.surface.endsWith('onboarding.ts'))?.hits.map((hit) => hit.term)).toEqual(['API Key']);
      expect(rows.find((row) => row.surface.endsWith('NewWizard.tsx'))?.hits.map((hit) => hit.term)).toEqual(['API Key', 'Provider', 'Base URL', 'Provider']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('real source census stays below its owned stock counts', () => {
    expect(compareSettingsJargon(scanSettingsJargon(), baseline.source)).toEqual([]);
  });
});
