// 无人值守额度用完时，醒来记录里给用户看的一句话（zh/en）。host 用 getHostUiLocale() 取语言。
export type UnattendedBudgetUsedUpLocale = 'zh' | 'en';

const UNATTENDED_BUDGET_USED_UP: Record<UnattendedBudgetUsedUpLocale, string> = {
  zh: '无人值守额度已用完',
  en: 'Unattended budget used up',
};

export function unattendedBudgetUsedUpText(locale: UnattendedBudgetUsedUpLocale): string {
  return UNATTENDED_BUDGET_USED_UP[locale];
}
