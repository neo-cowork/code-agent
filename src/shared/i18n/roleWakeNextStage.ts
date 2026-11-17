// 角色唤醒完成后接续阶段的标题（zh/en）。host 用 getHostUiLocale() 取语言。
export type RoleWakeNextStageLocale = 'zh' | 'en';

const NEXT_STAGE_TITLE: Record<RoleWakeNextStageLocale, string> = {
  zh: '角色唤醒后继续',
  en: 'Continue after role wake',
};

export function roleWakeNextStageTitle(locale: RoleWakeNextStageLocale): string {
  return NEXT_STAGE_TITLE[locale];
}
