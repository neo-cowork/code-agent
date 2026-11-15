// 日历只有一项授权（ADR-090 perm_calendars，N-CALENDAR-ONE-PERMISSION-EVENTKIT）：
// - 唯一真相 = 原生桥被动探针 calendarAccess（从不弹框）；授权卡、会前提醒开关、连接器页都读它。
// - 唯一授权出口 = askCalendarOnce（点击凭证弹一次 + 轮询）；点击凭证只在 envAssist.ipc.ts 里签发（授权边界）。
// - 任何入口读到完全访问 → settleCalendarGranted：所有会话里还挂着的日历授权卡一起收口，停在日历上的任务进入续做轮询。
import type { EnvAssistNotice } from '../../../shared/contract/envAssist';
import { getApplicationRunRegistry } from '../../app/applicationRunRegistry';
import { armEnvResumeOnSessionReturn } from '../../runtime/envResumeWaiter';
import { getDatabase } from '../../services/core/databaseService';
import { getSessionManager } from '../../services/infra/sessionManager';
import { createLogger } from '../../services/infra/logger';
import { askCalendarOnce, type CalendarAskDeps } from './calendarSetting';
import type { CalendarAccess } from './probes/passiveProbes';
import { resolveEnvAssistNotice } from './toolNotice';

const logger = createLogger('CalendarGrant');

/** 日历卡（新卡 perm_calendars；本单之前停下的老卡 perm_automation）都以 `|calendar` 结尾 */
export const isCalendarNotice = (notice: Pick<EnvAssistNotice, 'class' | 'target'> | undefined): boolean =>
  notice?.target?.id === 'calendar' && (notice.class === 'perm_calendars' || notice.class === 'perm_automation');

export interface CalendarClickDeps extends CalendarAskDeps {
  open: (pane: 'calendars') => Promise<boolean>;
  available: () => boolean;
}

/** 一次点击：未决定弹一次框并等答复；之前就拒绝 / 只给了「仅添加」打开「隐私与安全性 → 日历」（受限打开也改不了，不打开）。授权后的收口由调用方做。 */
export async function askCalendarFromClick(deps: CalendarClickDeps): Promise<{ access: CalendarAccess; opened: boolean }> {
  const asked = await askCalendarOnce(deps);
  const access = asked?.access ?? 'unavailable';
  // 已拒绝过（这次没弹框）才去系统设置；刚在框里点了「不允许」就尊重这次答复，不追着开设置页
  const opened = !asked?.prompted && (access === 'denied' || access === 'write_only') && deps.available() && await deps.open('calendars');
  return { access, opened };
}

/**
 * 探针已读到完全访问：把所有会话里还在等用户的日历授权卡写成「已允许」（持久化 + 广播，打开的窗口实时变），
 * 并对这些会话各武装一次 #3421 的续做轮询（停在日历授权上的任务自己接着做）。幂等，从不抛。
 */
export async function settleCalendarGranted(entry: string): Promise<void> {
  try {
    const rows = getDatabase().getDb()
      ?.prepare("SELECT id, session_id FROM messages WHERE id LIKE 'env-assist:%|calendar'")
      .all() as Array<{ id: string; session_id: string }> | undefined;
    const bySession = new Map<string, Set<string>>();
    for (const row of rows ?? []) {
      if (!bySession.has(row.session_id)) bySession.set(row.session_id, new Set());
      bySession.get(row.session_id)!.add(row.id);
    }
    for (const [sessionId, ids] of bySession) {
      // SessionManager applies the signed-in user's session ownership fence.
      const notices = (await getSessionManager().getMessages(sessionId))
        .filter((m) => ids.has(m.id))
        .map((m) => m.metadata?.envAssist)
        .filter((n): n is EnvAssistNotice => n?.phase === 'needs_user' && isCalendarNotice(n));
      for (const notice of notices) await resolveEnvAssistNotice(notice);
      if (notices.length > 0) armEnvResumeOnSessionReturn(sessionId, getApplicationRunRegistry(), entry);
    }
  } catch (error) {
    logger.warn('Calendar grant settle failed', { entry, error: error instanceof Error ? error.message : String(error) });
  }
}
