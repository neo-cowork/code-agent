import { describe, expect, it } from 'vitest';
import { getProviderDisplayName, getSettingsVocabulary } from '../../../src/renderer/i18n/settingsVocabulary';
import table from '../../../src/renderer/i18n/settingsTerms.json';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

describe('settings vocabulary', () => {
  it('uses the single term table in the zh model and wizard copy; preserves English labels', () => {
    const words = getSettingsVocabulary('zh');
    for (const term of table.terms.filter((entry) => entry.mode === 'enforce')) {
      expect(Object.values(words)).toContain(term.human);
    }
    expect(zh.settings.model.providerSection.title).toBe(words.provider);
    expect(zh.settings.model.connection.apiKey).toBe(words.keyLabel);
    expect(zh.settings.model.list.addProvider).toBe('新增模型服务');
    expect(zh.settings.model.list.searchPlaceholder).toBe('搜索模型服务或模型…');
    expect(zh.settings.model.header.apiKeySaved).toBe('密钥已保存');
    expect(zh.settings.model.header.selectableLabel).toBe('显示在模型选择里');
    expect(zh.settings.model.models.selectableLabel).toBe('显示在模型选择里');
    expect(zh.settings.model.connection.baseUrlHint).toBe(words.addressHint);
    expect(zh.onboarding.baseUrlHint).toBe(words.addressHint);
    expect(zh.settings.model.addProvider.baseUrlHint).toBe(words.addressHint);
    expect(en.settings.model.list.addProvider).toBe('Add Provider');
    expect(getSettingsVocabulary('en').keyLabel).toBe('API Key');
  });

  it('translates catalog default names but preserves user names in both languages', () => {
    expect(getProviderDisplayName('custom', 'Custom Provider', 'Custom Provider', 'zh')).toBe('自定义模型服务');
    expect(getProviderDisplayName('custom', undefined, 'Custom Provider', 'zh')).toBe('自定义模型服务');
    expect(getProviderDisplayName('custom', 'Custom Provider', 'Custom Provider', 'en')).toBe('Custom Provider');
    expect(getProviderDisplayName('custom', '我的服务', 'Custom Provider', 'zh')).toBe('我的服务');
    expect(getProviderDisplayName('zhipu', 'Zhipu GLM', '智谱 AI', 'zh')).toBe('智谱 AI');
    expect(getProviderDisplayName('zhipu', 'Zhipu GLM', 'Zhipu AI', 'en')).toBe('Zhipu GLM');
  });
});
