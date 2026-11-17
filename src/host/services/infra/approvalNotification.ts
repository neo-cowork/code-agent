import { permissionNotice } from '../../../shared/utils/toolUserLabel';
import { getConfigService } from '../core/configService';

/** Resolve approval-banner language once for every host producer and native fallback. */
export function buildApprovalNotification(
  tool?: string,
  context: 'approval' | 'parked' | 'native' = 'approval',
): { title: string; body: string } {
  let locale: 'zh' | 'en' = 'zh';
  try {
    if (getConfigService().getSettings().ui.language === 'en') locale = 'en';
  } catch {
    // A missing settings service must not interrupt the approval request.
  }
  return permissionNotice(tool, locale, context);
}
