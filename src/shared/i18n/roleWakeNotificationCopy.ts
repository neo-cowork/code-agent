import { localizeBuiltinRole } from '../localizeBuiltinRole';

/** Body used when a realtime role wake produced output without a summary line. */
export function roleWakeFallbackBody(locale: 'zh' | 'en', roleId: string): string {
  return locale === 'en'
    ? `${localizeBuiltinRole(roleId, { name: roleId }, 'en').name} produced new output`
    : `角色 ${roleId} 醒来产出了新内容`;
}
