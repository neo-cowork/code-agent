import { describe, expect, it } from 'vitest';
import { getProviderDisplayName, getSettingsVocabulary, localizeSettingsTerms } from '../../../src/renderer/i18n/settingsVocabulary';
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

  it('search index, unsaved dialog and compaction pointer use the same words', () => {
    const words = getSettingsVocabulary('zh');
    expect(zh.settings.searchIndex.modelProviders).toBe(words.provider);
    expect(zh.settings.searchIndex.apiKey).toBe(words.keyLabel);
    expect(zh.settings.unsavedChanges.message).toBe('「通用模型」里有尚未保存的模型服务配置修改，离开后会被丢弃。');
    expect(zh.settings.conversation.model.description).toBe('实际可用模型与密钥配置在「通用模型」页，本页只显示当前生效值。');
    expect(en.settings.searchIndex.apiKey).toBe('API Key');
    expect(zh.settings.privacyLabels.transcriptionService).toBe('转写服务: ');
    expect(en.settings.privacyLabels.transcriptionService).toBe('Provider: ');
  });

  it('translates host-supplied text at the display boundary without touching English or verbatim literals', () => {
    expect(localizeSettingsTerms('Provider connectivity', 'zh')).toBe('模型服务连通性');
    expect(localizeSettingsTerms('Provider 健康监控', 'zh')).toBe('模型服务健康监控');
    expect(localizeSettingsTerms('请前往模型设置更新对应 Provider 的 API Key', 'zh')).toBe('请前往模型设置更新对应模型服务的密钥');
    expect(localizeSettingsTerms('数据: provider API key、base URL', 'zh')).toBe('数据: 模型服务密钥、接口地址');
    expect(localizeSettingsTerms('使用 X-API-Key 头，不是 API Key 字段', 'zh')).toBe('使用 X-API-Key 头，不是密钥字段');
    expect(localizeSettingsTerms('读取 apiKeyConfigured 与 OpenAI provider 状态', 'zh')).toBe('读取 apiKeyConfigured 与 OpenAI 模型服务状态');
    expect(localizeSettingsTerms('choose the isolated Managed Browser provider.', 'zh')).toBe('choose the isolated Managed Browser provider.');
    expect(localizeSettingsTerms('Provider 健康监控', 'en')).toBe('Provider 健康监控');
    expect(localizeSettingsTerms('Provider connectivity', 'en')).toBe('Provider connectivity');
  });
});
