// ============================================================================
// 设置页白话词汇 —— 词表 settingsTerms.json 是唯一真源
// ============================================================================
// 同一份 JSON 同时被这里（渲染端 zh 文案取词）和 scripts/ci/check-settings-jargon.mjs
// （CI 门拦新增英文术语）读取，改词表两边同时生效，结构上不会分叉。
// 做法参照 permissionVocabulary.ts：zh 设置文案 import 这里取词，不手写英文术语。
// ============================================================================

import table from './settingsTerms.json';

interface SettingsTermEntry {
  id: string;
  term: string;
  human: string;
  mode: 'enforce' | 'report';
}

const humanById = (id: string): string => {
  const entry = (table.terms as SettingsTermEntry[]).find((t) => t.id === id);
  if (!entry) throw new Error(`settingsTerms.json 缺少词条: ${id}`);
  return entry.human;
};

export const settingsVocabularyZh = {
  /** Provider → 模型服务 */
  provider: humanById('provider'),
  /** Base URL → 接口地址 */
  baseUrl: humanById('baseUrl'),
  /** API Key → 密钥 */
  keyLabel: humanById('apiKey'),
};
