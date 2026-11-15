// 内置 provider 的展示名随界面语言：英文界面统一英文名，中文界面保持原样。
// 英文名来自 shared（注册表 / 模型目录），这里只保存中文界面要保留的原中文名与描述。
import { PROVIDER_REGISTRY, getProviderDisplayName } from '@shared/constants';
import type { Language } from './index';

interface ZhProviderText {
  name?: string;
  description?: string;
}

const ZH_PROVIDER_TEXT: Record<string, ZhProviderText> = {
  zhipu: { name: '智谱 AI' },
  qwen: { name: '通义千问' },
  xiaomi: { name: '小米 MiMo', description: '小米 Token Plan 包月套餐（OpenAI 兼容）' },
  volcengine: { name: '火山引擎 (豆包)', description: '字节跳动豆包系列模型' },
  longcat: { description: 'LongCat API 开放平台（OpenAI / Claude 兼容）' },
  local: { description: '本地 Ollama 模型' },
  grok: { description: 'xAI Grok 系列' },
  custom: { description: 'OpenAI-compatible 自定义服务商' },
};

// 注册表里中文界面本来就显示英文名的 provider（zhipu/qwen）保持不变，只有这两家原本是中文。
const ZH_REGISTRY_LABEL_IDS = new Set(['xiaomi', 'volcengine']);

/** 注册表来源的标签（缺 key 提示、切换器分组、任务策略分组）：仅当 label 就是内置默认名时才本地化，用户自命名不动。 */
function localizeProviderLabel(provider: string, label: string, language: Language): string {
  if (language !== 'zh' || !ZH_REGISTRY_LABEL_IDS.has(provider)) return label;
  if (label !== getProviderDisplayName(provider)) return label;
  return ZH_PROVIDER_TEXT[provider]?.name ?? label;
}

export function getLocalizedProviderDisplayName(provider: string, language: Language): string | undefined {
  const label = getProviderDisplayName(provider);
  return label === undefined ? undefined : localizeProviderLabel(provider, label, language);
}

/** 模型目录来源的名称（语音等选择器）：中文界面保留原中文名。 */
export function localizeCatalogProviderName(provider: { id: string; name: string }, language: Language): string {
  return (language === 'zh' && ZH_PROVIDER_TEXT[provider.id]?.name) || provider.name;
}

/** 设置页 provider 列表的名称与描述：i18n 词条优先，中文界面再补原中文，最后回落目录（英文）。 */
export function resolveProviderText(
  provider: string,
  tableEntry: ZhProviderText | undefined,
  language: Language,
  catalog: { name: string; description: string },
): { name: string; description: string } {
  const zh = language === 'zh' ? ZH_PROVIDER_TEXT[provider] : undefined;
  return {
    name: tableEntry?.name || zh?.name || catalog.name,
    description: tableEntry?.description || zh?.description || catalog.description,
  };
}

/** 切换器 / 任务策略分组的 provider 标签：运行时选项自带的 label 优先，缺省取注册表名，再按界面语言本地化。 */
export function resolveProviderLabel(provider: string, label: string | undefined, language: Language): string {
  return localizeProviderLabel(provider, label || getProviderDisplayName(provider) || provider, language);
}

/** Doctor 连通性项只带注册表默认名（host 不知界面语言）：network 类且名字等于某内置 provider 默认名时，按界面语言本地化。 */
export function localizeDoctorItemName(item: { category: string; name: string }, language: Language): string {
  if (item.category !== 'network') return item.name;
  const id = Object.keys(PROVIDER_REGISTRY).find((key) => PROVIDER_REGISTRY[key as keyof typeof PROVIDER_REGISTRY].displayName === item.name);
  return id ? localizeProviderLabel(id, item.name, language) : item.name;
}
