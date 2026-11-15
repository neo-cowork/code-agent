// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../../src/shared/contract';
import { PROVIDER_MODELS, PROVIDER_REGISTRY } from '../../../src/shared/constants';
import { en, zh, type Language } from '../../../src/renderer/i18n';
import {
  getLocalizedProviderDisplayName,
  localizeCatalogProviderName,
  resolveProviderLabel,
  resolveProviderText,
} from '../../../src/renderer/i18n/providerDisplay';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { ModelSettings } from '../../../src/renderer/components/features/settings/tabs/ModelSettings';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: vi.fn(async (_domain: string, action: string) => action === 'get' ? { models: { default: 'xiaomi', routing: {}, providers: {} } } : undefined) },
}));
vi.mock('../../../src/renderer/utils/platform', () => ({ isWebMode: () => false }));

const CJK = /[一-鿿]/;
const TABLES = { en, zh } as const;
const catalogIds = PROVIDER_MODELS.map((p) => p.id);
const registryIds = Object.keys(PROVIDER_REGISTRY);
// 中文界面保持原样：这四家原本在列表/选择器里是中文名
const ZH_LIST_NAMES: Record<string, string> = { zhipu: '智谱 AI', qwen: '通义千问', xiaomi: '小米 MiMo', volcengine: '火山引擎 (豆包)' };

function Settings() {
  const [config, setConfig] = useState<ModelConfig>({ provider: 'xiaomi', model: 'mimo-v2.6-flash', apiKey: '', temperature: 0.7 });
  return <ModelSettings config={config} onChange={setConfig} />;
}

beforeEach(() => useAppStore.setState({ language: 'en', settingsModelFocus: null, settingsMemoryFocus: null }));
afterEach(cleanup);

describe.each(['en', 'zh'] as const)('provider display names (%s)', (language: Language) => {
  it('missing-key notice names every built-in provider per UI language', () => {
    for (const id of registryIds) {
      const label = getLocalizedProviderDisplayName(id, language);
      expect(label, id).toBeTruthy();
      const notice = TABLES[language].modelSetup.missingApiKey.replace('{provider}', label!);
      if (language === 'en') expect(notice, id).not.toMatch(CJK);
    }
    const zhLabel = (id: string) => getLocalizedProviderDisplayName(id, 'zh');
    expect(zhLabel('xiaomi')).toBe('小米 MiMo');
    expect(zhLabel('volcengine')).toBe('火山引擎 (豆包)');
    expect(zhLabel('zhipu')).toBe('Zhipu GLM'); // 中文界面此处原本就是注册表英文名
  });

  it('list / picker / group names for every catalog provider', () => {
    const providerTexts = TABLES[language].settings.model.providers as Record<string, { name?: string; description?: string }>;
    for (const p of PROVIDER_MODELS) {
      const text = resolveProviderText(p.id, providerTexts[p.id === 'claude' ? 'anthropic' : p.id], language, p);
      const picker = localizeCatalogProviderName(p, language);
      const group = resolveProviderLabel(p.id, undefined, language);
      if (language === 'en') {
        for (const value of [text.name, text.description, picker, group]) expect(value, p.id).not.toMatch(CJK);
      } else if (ZH_LIST_NAMES[p.id]) {
        expect(text.name, p.id).toBe(ZH_LIST_NAMES[p.id]);
        expect(picker, p.id).toBe(ZH_LIST_NAMES[p.id]);
      }
    }
  });

  it('every catalog and registry entry is English at the source', () => {
    for (const p of PROVIDER_MODELS) {
      expect(p.name, p.id).not.toMatch(CJK);
      expect(p.description, p.id).not.toMatch(CJK);
    }
    for (const id of registryIds) expect(PROVIDER_REGISTRY[id as keyof typeof PROVIDER_REGISTRY].displayName, id).not.toMatch(CJK);
    expect(catalogIds.length).toBeGreaterThan(10);
  });

  it('ModelSettings provider list renders per-language names', async () => {
    useAppStore.setState({ language });
    const view = render(<Settings />);
    await waitFor(() => expect(view.container.querySelector('aside')).toBeTruthy());
    const expand = view.container.querySelector<HTMLButtonElement>('aside button[title]');
    if (expand) fireEvent.click(expand);
    const list = view.container.querySelector('aside')!.textContent ?? '';
    if (language === 'en') {
      expect(list).not.toMatch(CJK);
      for (const name of ['Xiaomi MiMo', 'Volcengine (Doubao)', 'Zhipu GLM', 'Qwen']) expect(list).toContain(name);
    } else {
      for (const name of Object.values(ZH_LIST_NAMES)) expect(list).toContain(name);
    }
  });
});
