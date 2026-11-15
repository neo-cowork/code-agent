// 「会前提醒我记这场会」开关的授权流程（ADR-090 perm_calendars，验收②）。
// 渲染层只发请求；开关只由这里在被动探针确认「完全访问」后写成开。弹框只在用户点击签发的凭证里发生一次。
import { ENV_ASSIST_CALENDAR_CONFIRM_MS, ENV_ASSIST_CALENDAR_POLL_MS } from '../../../shared/constants/envAssist';
import type { CalendarSettingResult } from '../../../shared/contract/envAssist';
import type { CalendarAccess } from './probes/passiveProbes';

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
  const before = await deps.access();
  if (before !== 'undecided') return finish(deps, state, before);
  state.pending = true;
  if (await deps.prompt() !== 'requested') {
    state.pending = false;
    return { on: false, reason: 'unavailable' };
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + ENV_ASSIST_CALENDAR_CONFIRM_MS;
  while (now() < deadline) {
    await sleep(ENV_ASSIST_CALENDAR_POLL_MS);
    const access = await deps.access();
    if (settled(access)) return finish(deps, state, access);
  }
  return { on: false, reason: 'undecided' }; // 还在系统框里没作答：开关退回关，回头再看（recheck）
}

/**
 * 设置页打开 / 窗口重新聚焦：被动再看一眼（从不弹框）。设置已开但授权没了 → 显示关（revoked）。
 * 只有发起过、还没等到答复的那次开启请求，在用户后来点了「允许」时补成开；从没发起过请求的一律不自动开。
 */
export async function recheckCalendarReminder(deps: CalendarSettingDeps, state: PendingEnable): Promise<CalendarSettingResult> {
  // 显示为开 = 设置是开 && 被动探针仍是完全访问；授权被撤（tccutil reset / 系统设置里关掉）就显示关并提示重新允许
  if (deps.readSetting()) return (await deps.access()) === 'granted' ? { on: true } : { on: false, reason: 'revoked' };
  if (!state.pending) return { on: false };
  const access = await deps.access();
  if (access === 'granted') return finish(deps, state, access);
  if (settled(access)) {
    state.pending = false;
    return { on: false, reason: access };
  }
  return { on: false };
}
