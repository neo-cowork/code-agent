// 插件卡头部 pill 的显示名：中文界面把内置枚举值译成中文，英文界面与未知值保持原样。
// marketplace 名是用户给的，只翻译宿主内置官方源（SKILL_REGISTRY_MARKETPLACE_ID）。

import { SKILL_REGISTRY_MARKETPLACE_ID } from '../../../../../shared/contract/skillRegistry';

type PillKind = 'marketplace' | 'scope' | 'type';

const ZH_PILL_LABELS: Record<PillKind, Record<string, string>> = {
  marketplace: { [SKILL_REGISTRY_MARKETPLACE_ID]: '官方' },
  scope: { user: '用户级', project: '项目级' },
  type: { skill: '技能', command: '命令', ui: '界面', theme: '主题', provider: '模型服务' },
};

export function getPluginPillLabel(kind: PillKind, value: string, language: string): string {
  if (language !== 'zh') return value;
  return ZH_PILL_LABELS[kind][value] ?? value;
}
