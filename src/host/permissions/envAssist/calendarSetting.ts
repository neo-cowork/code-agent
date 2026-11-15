// 「会前提醒我记这场会」开关的授权流程（ADR-090 perm_calendars，验收②）。
// 渲染层只发请求；开关只由这里在被动探针确认「完全访问」后写成开。弹框只在用户点击签发的凭证里发生一次。
import { ENV_ASSIST_CALENDAR_CONFIRM_MS, ENV_ASSIST_CALENDAR_POLL_MS } from '../../../shared/constants/envAssist';
import type { CalendarSettingResult } from '../../../shared/contract/envAssist';
import type { CalendarAccess } from './probes/passiveProbes';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('CalendarGrant');

export interface CalendarSettingDeps {
  access: () => Promise<CalendarAccess>;
  /** 签发一次性点击凭证并发起系统授权框（立即返回，不等用户作答） */
  prompt: () => Promise<'requested' | 'rejected' | 'not_available'>;
  open: (pane: 'calendars') => Promise<boolean>;
  available: () => boolean;
  readSetting: () => boolean;
  writeSetting: (on: boolean) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 探针读到完全访问时：所有入口的日历授权卡一起收口、停住的任务续做（calendarGrant.settleCalendarGranted） */
  granted?: () => Promise<void>;
}

export type CalendarAskDeps = Pick<CalendarSettingDeps, 'access' | 'prompt' | 'sleep' | 'now'>;

/**
 * 一次点击里的日历授权（卡片按钮 / 会前提醒开关 / 连接器页修复权限共用）：被动看一眼，只有「未决定」才凭点击凭证弹一次系统框，
 * 再每秒被动轮询到有答复（≤ ENV_ASSIST_CALENDAR_CONFIRM_MS）。null = 没能发起系统框。
 */
// 同一时刻只有一次「弹框 + 等答复」：卡片、开关、连接器页谁先点谁发起，后点的直接等同一个答复，不再弹第二个框
let waiting: Promise<{ access: CalendarAccess; prompted: boolean } | null> | null = null;

export async function askCalendarOnce(deps: CalendarAskDeps, onPrompt?: () => void): Promise<{ access: CalendarAccess; prompted: boolean } | null> {
  const before = await deps.access();
  if (before !== 'undecided') {
    logger.info('Calendar ask: already decided, no dialog', { access: before });
    return { access: before, prompted: false };
  }
  onPrompt?.();
  if (waiting) {
    logger.info('Calendar ask: joining the dialog already waiting for an answer');
    return waiting;
  }
  waiting = (async () => {
    const prompt = await deps.prompt();
    logger.info('Calendar ask: dialog requested', { prompt });
    if (prompt !== 'requested') return null;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = deps.now ?? Date.now;
    const started = now();
    const deadline = started + ENV_ASSIST_CALENDAR_CONFIRM_MS;
    let polls = 0;
    while (now() < deadline) {
      await sleep(ENV_ASSIST_CALENDAR_POLL_MS);
      polls += 1;
      const access = await deps.access();
      if (settled(access)) {
        logger.info('Calendar ask: answered', { access, polls, waitedMs: now() - started });
        return { access, prompted: true };
      }
    }
    logger.warn('Calendar ask: no answer within the confirm window', { polls });
    return { access: 'undecided' as const, prompted: true }; // 还在系统框里没作答
  })();
  try { return await waiting; } finally { waiting = null; }
}

/**
 * 发起过、但 60 秒确认窗口里还没等到答复的那次开启请求（验收补充 A）。
 * ponytail: 只在内存里记，重启 Neo 就忘；跨重启补开要落盘时再加。
 */
export interface PendingEnable { pending: boolean }

const settled = (access: CalendarAccess): access is 'granted' | 'denied' | 'restricted' | 'write_only' =>
  access === 'granted' || access === 'denied' || access === 'restricted' || access === 'write_only';

async function finish(deps: CalendarSettingDeps, state: PendingEnable, access: CalendarAccess): Promise<CalendarSettingResult> {
  if (access === 'granted') {
    state.pending = false;
    await deps.writeSetting(true);
    await deps.granted?.();
    return { on: true };
  }
  if (access === 'denied' || access === 'write_only') {
    state.pending = false;
    // 拒绝过的不会再弹框，只能去系统设置改；受限（家长控制/公司管理）打开也改不了，不打开
    const opened = deps.available() && await deps.open('calendars');
    return { on: false, reason: access, opened };
  }
  if (access === 'restricted') state.pending = false;
  return { on: false, reason: access };
}

/** 用户把开关从关点到开 */
export async function enableCalendarReminder(deps: CalendarSettingDeps, state: PendingEnable): Promise<CalendarSettingResult> {
  const asked = await askCalendarOnce(deps, () => { state.pending = true; });
  if (!asked) {
    state.pending = false;
    return { on: false, reason: 'unavailable' };
  }
  // 窗口内没等到答复：开关退回关，回头再看（recheck）
  if (asked.prompted && asked.access === 'undecided') return { on: false, reason: 'undecided' };
  return finish(deps, state, asked.access);
}

/**
 * 设置页打开 / 窗口重新聚焦：被动再看一眼（从不弹框）。设置已开但授权没了 → 显示关（revoked）。
 * 只有发起过、还没等到答复的那次开启请求，在用户后来点了「允许」时补成开；从没发起过请求的一律不自动开。
 */
export async function recheckCalendarReminder(deps: CalendarSettingDeps, state: PendingEnable): Promise<CalendarSettingResult> {
  // 显示为开 = 设置是开 && 被动探针仍是完全访问；授权被撤（tccutil reset / 系统设置里关掉）就显示关并提示重新允许
  if (deps.readSetting()) {
    if ((await deps.access()) !== 'granted') return { on: false, reason: 'revoked' };
    await deps.granted?.();
    return { on: true };
  }
  if (!state.pending) return { on: false };
  const access = await deps.access();
  if (access === 'granted') return finish(deps, state, access);
  if (settled(access)) {
    state.pending = false;
    return { on: false, reason: access };
  }
  return { on: false };
}
