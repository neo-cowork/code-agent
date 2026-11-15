import type { Translations } from '../i18n/zh';

/**
 * 内置多模态模型显示名的唯一出口：按模型 id 取语言包里的写法；
 * 语言包没收录的（用户自定义模型、名字本来就是英文的内置模型）显示来源给的名字。
 */
export function getVisualModelLabel(
  model: { id: string; label: string },
  copy: Translations['visualModelLabels'],
): string {
  const labels: Record<string, string | undefined> = copy;
  return labels[model.id] ?? model.label;
}
