import { permissionNotice } from '../../../shared/utils/toolUserLabel';
import { isPlaceholderSessionTitle } from '../../../shared/sessionTitlePlaceholder';
import { getAuthService } from '../auth/authService';
import { getDatabase } from '../core/databaseService';
import { sanitizeNotificationText } from './notificationPolicy';
import { getConfigService } from '../core/configService';

/** Resolve approval-banner language once for every host producer and native fallback. */
export function buildApprovalNotification(
  tool?: string,
  context: 'approval' | 'parked' | 'first_wake' = 'approval',
  sessionId?: string,
): { title: string; body: string } {
  let locale: 'zh' | 'en' = 'zh';
  try {
    if (getConfigService().getSettings().ui.language === 'en') locale = 'en';
  } catch {
    // A missing settings service must not interrupt the approval request.
  }
  return permissionNotice(tool, locale, context, sessionId ? readApprovalTaskName(sessionId) : undefined);
}

function readApprovalTaskName(sessionId: string): string | undefined {
  try {
    const userId = getAuthService().getCurrentUser()?.id ?? null;
    // Local row only. Keep the lookup synchronous so a retract cannot overtake notification dedupe.
    const rawTitle = getDatabase().getSession(sessionId, { userId })?.title;
    if (isPlaceholderSessionTitle(rawTitle)) return undefined;
    const title = sanitizeNotificationText(rawTitle, 120, { omitIds: true }).trim();
    const characters = Array.from(title);
    return characters.length > 40 ? `${characters.slice(0, 39).join('').trimEnd()}…` : title;
  } catch {
    return undefined;
  }
}
