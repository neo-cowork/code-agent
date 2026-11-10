// 设置页白话词汇：词表 JSON 是唯一真源，模型页 / onboarding 的中文文案从它取词。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { settingsVocabularyZh } from '../../../src/renderer/i18n/settingsVocabulary';
import table from '../../../src/renderer/i18n/settingsTerms.json';

const ENGLISH_TERMS = /provider|base\s*url|api[\s-]?key|\bkey\b/i;

function collect(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (node && typeof node === 'object') for (const v of Object.values(node)) collect(v, out);
  return out;
}

describe('settingsVocabulary', () => {
  afterEach(() => {
    vi.doUnmock('../../../src/renderer/i18n/settingsTerms.json');
    vi.resetModules();
  });

  it('词汇取自词表 human 字段', () => {
    const human = (id: string) => table.terms.find((t) => t.id === id)?.human;
    expect(settingsVocabularyZh).toEqual({
      provider: human('provider'),
      baseUrl: human('baseUrl'),
      keyLabel: human('apiKey'),
    });
    expect(settingsVocabularyZh).toEqual({ provider: '模型服务', baseUrl: '接口地址', keyLabel: '密钥' });
  });

  it('改词表即改渲染端词汇（同一份 JSON）', async () => {
    vi.resetModules();
    vi.doMock('../../../src/renderer/i18n/settingsTerms.json', () => ({
      default: { terms: [
        { id: 'provider', term: 'Provider', human: '服务X', mode: 'enforce' },
        { id: 'baseUrl', term: 'Base URL', human: '地址Y', mode: 'enforce' },
        { id: 'apiKey', term: 'API Key', human: '钥匙Z', mode: 'enforce' },
      ] },
    }));
    const mod = await import('../../../src/renderer/i18n/settingsVocabulary');
    expect(mod.settingsVocabularyZh).toEqual({ provider: '服务X', baseUrl: '地址Y', keyLabel: '钥匙Z' });
    const zhModels = await import('../../../src/renderer/i18n/zhSettingsModels');
    expect(zhModels.zhSettingsModels.model.addProvider.title).toBe('新增服务X');
  });

  it('模型页点名字符串用白话词，不含英文术语；英文页不变', () => {
    const m = zh.settings.model;
    expect(m.addProvider.title).toBe('新增模型服务');
    expect(m.list.addProvider).toBe('新增模型服务');
    expect(m.list.searchPlaceholder).toBe('搜索模型服务或模型…');
    expect(m.header.apiKeySaved).toBe('密钥已保存');
    expect(m.connection.baseUrlLabel).toBe('接口地址');
    expect(m.list.keyStatus).toBe('✓ 密钥');
    expect(m.list.addKey).toBe('添加密钥');
    expect(m.list.unconfiguredPrefix).toBe('待添加密钥 · ');
    expect(m.addProvider.apiKeyLabel).toBe('密钥');
    for (const s of [
      m.addProvider.title, m.addProvider.apiKeyLabel, m.list.keyStatus, m.list.addKey, m.list.searchPlaceholder,
      m.list.addProvider, m.list.unconfiguredPrefix, m.header.apiKeySaved, m.header.selectableTitle,
      m.connection.baseUrlLabel, m.connection.baseUrlHint, m.connection.localNoApiKeyPlaceholder,
      zh.settings.search.keySaved, zh.onboarding.baseUrlLabel, zh.onboarding.apiKeyPlaceholder,
    ]) {
      expect(s, s).not.toMatch(ENGLISH_TERMS);
    }
    // 同页同一概念只有一个词：小节标题、连接表单密钥标签取自词汇
    expect(m.providerSection.title).toBe(settingsVocabularyZh.provider);
    expect(m.connection.apiKey).toBe(settingsVocabularyZh.keyLabel);
    expect(m.header.selectableLabel).toBe('显示在模型选择里');
    expect(m.models.selectableLabel).toBe('显示在模型选择里');
    expect(m.models.selectionHint).toContain('显示在模型选择里');
    for (const gone of ['模型提供商', 'API 密钥', '进模型选择页', '进选择页']) {
      expect(collect(m).join('|'), gone).not.toContain(gone);
    }
    expect(m.providers.custom.name).toBe('自定义模型服务');
    expect(m.connection.baseUrlHint).toContain('/v1');
    expect(m.connection.baseUrlHint).toContain('Claude');
    expect(collect(en.settings.model.list).join('|')).toContain('Provider');
    expect(en.onboarding.baseUrlLabel).toBe('Base URL');
    expect(zh.onboarding.keyFieldLabel).toBe(settingsVocabularyZh.keyLabel);
    expect(en.onboarding.keyFieldLabel).toBe('API Key');
  });
});
