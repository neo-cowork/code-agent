// 无人值守额度用完时，醒来记录里给用户看的一句话（zh/en）。host 用 getHostUiLocale() 取语言。
export type UnattendedBudgetUsedUpLocale = 'zh' | 'en';

const UNATTENDED_BUDGET_USED_UP: Record<UnattendedBudgetUsedUpLocale, string> = {
  zh: '无人值守额度已用完',
  en: 'Unattended budget used up',
};

export function unattendedBudgetUsedUpText(locale: UnattendedBudgetUsedUpLocale): string {
  return UNATTENDED_BUDGET_USED_UP[locale];
}

/** 失败记录里的原始错误是不是「无人值守额度用完」（两种语言都认，界面语言与记录写入时可能不同）。 */
export function isUnattendedBudgetUsedUpError(error: string | undefined | null): boolean {
  const text = error?.trim();
  return !!text && Object.values(UNATTENDED_BUDGET_USED_UP).includes(text);
}
