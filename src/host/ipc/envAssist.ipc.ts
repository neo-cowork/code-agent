import type { CalendarSettingResult, EnvAssistNotice, EnvAssistActResult } from '../../shared/contract/envAssist';
import { EnvAssistSchemas } from '../../shared/ipc/schemas/envAssist';
import { ipcHost } from '../platform';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { getDatabase } from '../services/core/databaseService';
import { getSessionManager } from '../services/infra/sessionManager';
import { canOpenEnvSettings, openEnvSettings } from '../permissions/envAssist/settingsPane';

import { createCuaHelperGrantBridge, type CuaHelperGrantBridge } from '../permissions/envAssist/grants/cuaHelperGrantBridge';
import { createDefaultGrantBridge, mintClickToken, requestGrant, requestHelperGrant } from '../permissions/envAssist/grants/requestGrant';
import { accessibilityProbe, automationProbe, calendarAccess, inputMonitoringProbe, screenRecordingProbe } from '../permissions/envAssist/probes/passiveProbes';
import { askCalendarOnce, enableCalendarReminder, recheckCalendarReminder, type CalendarSettingDeps, type PendingEnable } from '../permissions/envAssist/calendarSetting';
import { askCalendarFromClick, isCalendarNotice, settleCalendarGranted } from '../permissions/envAssist/calendarGrant';
import type { CalendarAccess } from '../permissions/envAssist/probes/passiveProbes';
import { readCuaHelperPermissionState, type CuaHelperPermissionState } from '../permissions/envAssist/cua/helperPermissionState';
import { cuaHelperProbe } from '../permissions/envAssist/probes/cuaHelperProbe';
import { createShellPassiveBridge } from '../permissions/envAssist/probes/shellPassiveBridge';
import type { ProbeResult, ReadOnlyProbe } from '../permissions/envAssist/probes/types';
import { resolveShellBridgeClientFromEnv } from '../permissions/envAssist/shellBridge/client';
import { resolveEnvAssistNotice } from '../permissions/envAssist/toolNotice';
import { createLogger } from '../services/infra/logger';
import { armEnvResumeOnSessionReturn, type EnvResumeProbeFactory } from '../runtime/envResumeWaiter';
import { getApplicationRunRegistry } from '../app/applicationRunRegistry';

const logger = createLogger('EnvAssistIpc');

async function findNotice(id: string): Promise<EnvAssistNotice | undefined> {
  const messageId = `env-assist:${id}`;
  const row = getDatabase().getDb()?.prepare('SELECT session_id FROM messages WHERE id = ?').get(messageId) as { session_id: string } | undefined;
  if (!row) return undefined;
  // SessionManager applies the signed-in user's session ownership fence.
  return (await getSessionManager().getMessages(row.session_id)).find((m) => m.id === messageId)?.metadata?.envAssist;
}

interface EnvAssistDependencies {
  passiveBridge?: Parameters<typeof accessibilityProbe>[0];
  grantBridge?: Parameters<typeof requestGrant>[2];
  /** cua helper identity (separate from the shell bridges above). */
  cuaHelperState?: () => Promise<CuaHelperPermissionState>;
  cuaHelperGrantBridge?: CuaHelperGrantBridge | null;
  now?: () => number;
  available: () => boolean;
  open: (pane: string) => Promise<boolean>;
  findNotice: (id: string) => Promise<EnvAssistNotice | undefined>;
  /** Persists + broadcasts the notice as resolved once a probe reads granted (default: resolveEnvAssistNotice). */
  resolve?: (notice: EnvAssistNotice) => Promise<void>;
  /** Reads / writes the gated setting (default: configService). Only the host turns it on, after a granted probe. */
  calendarReminderSetting?: { read: () => boolean; write: (on: boolean) => Promise<void> };
  /** A probe read calendar full access: settle every calendar card in every session (default: settleCalendarGranted). */
  calendarGranted?: (entry: string) => Promise<void>;
  sleep?: CalendarSettingDeps['sleep'];
}

async function defaultCalendarReminderSetting(): Promise<NonNullable<EnvAssistDependencies['calendarReminderSetting']>> {
  const { getConfigService } = await import('../services/core/configService');
  const config = getConfigService();
  return {
    read: () => config.getSettings().meeting?.calendarReminder === true,
    write: (on) => config.updateSettings({ meeting: { calendarReminder: on } }),
  };
}

/** One pending-enable flag per installed handler set (one per process in production). */
const calendarPending = new WeakMap<EnvAssistDependencies, PendingEnable>();
function pendingFor(deps: EnvAssistDependencies): PendingEnable {
  let state = calendarPending.get(deps);
  if (!state) calendarPending.set(deps, state = { pending: false });
  return state;
}

async function calendarSettingDeps(deps: EnvAssistDependencies): Promise<CalendarSettingDeps> {
  const setting = deps.calendarReminderSetting ?? await defaultCalendarReminderSetting();
  return {
    access: () => calendarAccess(deps.passiveBridge ?? null),
    // The IPC call is the user's click on the switch: one token, one dialog request.
    prompt: () => requestGrant(mintClickToken('setting:meetingCalendarReminder', deps.now), { pane: 'calendars' }, deps.grantBridge ?? null, deps.now)
      .catch(() => 'not_available' as const),
    open: deps.open,
    available: deps.available,
    readSetting: setting.read,
    writeSetting: setting.write,
    sleep: deps.sleep,
    now: deps.now,
    granted: () => (deps.calendarGranted ?? settleCalendarGranted)('meeting_reminder_setting'),
  };
}

/** The one calendar truth as a card outcome: anything short of full access reads as not granted. */
function calendarOutcome(access: CalendarAccess): ProbeResult {
  if (access === 'granted' || access === 'undecided') return { status: access };
  return access === 'unavailable' ? { status: 'unavailable', reason: 'calendar_probe_unavailable' } : { status: 'denied' };
}

// Notice targets are Neo's own ids (i18n keys); TCC needs the target app's bundle id.
// Calendar is not an Apple-events target any more: it is EventKit's perm_calendars (one permission, see calendarGrant.ts).
const AUTOMATION_BUNDLE_IDS: Readonly<Record<string, string>> = {
  mail: 'com.apple.mail', reminders: 'com.apple.reminders',
};
const automationBundleId = (targetId: string | undefined) => (targetId ? AUTOMATION_BUNDLE_IDS[targetId] : undefined);

function resolveGrantProbe(
  pane: string,
  bridge: EnvAssistDependencies['passiveBridge'],
  targetBundleId: string | undefined,
): ReadOnlyProbe | null {
  const passive = bridge ?? null;
  switch (pane) {
    case 'accessibility': return accessibilityProbe(passive);
    case 'screenCapture': return screenRecordingProbe(passive);
    case 'inputMonitoring': return inputMonitoringProbe(passive);
    case 'automation': return targetBundleId ? automationProbe(passive, targetBundleId) : null;
    default: return null;
  }
}

/** Passive (never-prompting) probe for the permission a notice is waiting on. */
function noticeProbe(deps: EnvAssistDependencies, notice: EnvAssistNotice, pane: string): ReadOnlyProbe | null {
  // New calendar cards (pane calendars) and cards parked before the switch (pane automation) read the same EventKit truth.
  if (isCalendarNotice(notice)) return async () => calendarOutcome(await calendarAccess(deps.passiveBridge ?? null));
  if (notice.target?.id.startsWith('helper')) {
    return pane === 'accessibility' || pane === 'screenCapture' ? cuaHelperProbe(deps.cuaHelperState ?? readCuaHelperPermissionState, pane) : null;
  }
  return resolveGrantProbe(pane, deps.passiveBridge, automationBundleId(notice.target?.id));
}

/** Every probe that reads granted closes the card, whether the grant came from the button or from System Settings. */
async function settle<T extends EnvAssistActResult>(deps: EnvAssistDependencies, notice: EnvAssistNotice, result: T): Promise<T> {
  if (result.outcome?.status !== 'granted') return result;
  // The grant itself already happened; a failed write-back must not turn the click into an error.
  try { await (deps.resolve ?? resolveEnvAssistNotice)(notice); } catch (error) {
    logger.warn('Env-assist notice resolve failed', { noticeId: notice.id, error: error instanceof Error ? error.message : String(error) });
  }
  // Wake the run this card parked (no-op when nothing is parked or a waiter is already polling; never throws).
  armEnvResumeOnSessionReturn(notice.sessionId, getApplicationRunRegistry(), 'env_assist_granted');
  // One calendar permission: the same grant also closes calendar cards in every other session and wakes their runs.
  if (isCalendarNotice(notice)) await (deps.calendarGranted ?? settleCalendarGranted)('env_assist_granted');
  return withResolvedNotice(deps, notice.id, result);
}

/**
 * Hand the card its persisted resolved copy. 11-15 real run: a grant made from the settings page resolved the card in
 * the database, but the chat view wasn't listening for the broadcast, so the card kept its button until a reload.
 */
async function withResolvedNotice<T extends EnvAssistActResult>(deps: EnvAssistDependencies, id: string, result: T): Promise<T> {
  const stored = await deps.findNotice(id).catch(() => undefined);
  return stored?.phase === 'resolved' ? { ...result, notice: stored } : result;
}

const defaults: EnvAssistDependencies = { available: canOpenEnvSettings, open: openEnvSettings, findNotice };
/** A cua-helper grant notice is single-use: one click, one helper call. */
const consumedHelperNotices = new Set<string>();
const routes = defineDomainRoutes(EnvAssistSchemas.REQUEST, {
  getAvailability: (deps: EnvAssistDependencies) => ({ available: deps.available() }),
  /** Card mount / window focus: a passive re-read, so a grant made in System Settings also closes the card. */
  recheck: async (deps: EnvAssistDependencies, payload: unknown): Promise<EnvAssistActResult> => {
    const parsed = EnvAssistSchemas.recheck.safeParse(payload);
    if (!parsed.success) return { status: 'rejected' };
    const notice = await deps.findNotice(parsed.data.noticeId);
    // Already resolved elsewhere (another card, the reminder switch, System Settings): give the card its done copy.
    if (notice?.phase === 'resolved') return { status: 'checked', outcome: { status: 'granted' }, notice };
    const actionPayload = notice?.action?.payload;
    if (notice?.phase !== 'needs_user' || !actionPayload || !('pane' in actionPayload)) return { status: 'rejected' };
    const probe = noticeProbe(deps, notice, actionPayload.pane);
    if (!probe) return { status: 'rejected' };
    return settle(deps, notice, { status: 'checked', outcome: await probe() });
  },
  /** Settings switch off→on (the click): passive check → one-shot dialog → poll; the host writes the setting only when granted. */
  enableSettingGrant: async (deps: EnvAssistDependencies, payload: unknown): Promise<CalendarSettingResult> => {
    if (!EnvAssistSchemas.settingGrant.safeParse(payload).success) return { on: false, reason: 'unavailable' };
    return enableCalendarReminder(await calendarSettingDeps(deps), pendingFor(deps));
  },
  /** Settings page mount / window focus: passive only, never prompts. */
  recheckSettingGrant: async (deps: EnvAssistDependencies, payload: unknown): Promise<CalendarSettingResult> => {
    if (!EnvAssistSchemas.settingGrant.safeParse(payload).success) return { on: false, reason: 'unavailable' };
    return recheckCalendarReminder(await calendarSettingDeps(deps), pendingFor(deps));
  },
  act: async (deps: EnvAssistDependencies, payload: unknown): Promise<EnvAssistActResult> => {
    const parsed = EnvAssistSchemas.act.safeParse(payload);
    if (!parsed.success) return { status: 'rejected' };
    const request = parsed.data;
    const notice = await deps.findNotice(request.noticeId);
    const action = notice?.action;
    if (notice?.phase !== 'needs_user' || action?.kind !== request.actionKind
      || !action?.payload || !('pane' in action.payload) || action.payload.pane !== request.payload.pane) {
      return { status: 'rejected' };
    }
    if (request.actionKind === 'request_grant' && notice.target?.id.startsWith('helper')) {
      const pane = request.payload.pane;
      if ((pane !== 'accessibility' && pane !== 'screenCapture') || consumedHelperNotices.has(notice.id)) return { status: 'rejected' };
      consumedHelperNotices.add(notice.id);
      const grant = await requestHelperGrant(mintClickToken(notice.id, deps.now), deps.cuaHelperGrantBridge ?? null, deps.now);
      const outcome = await cuaHelperProbe(deps.cuaHelperState ?? readCuaHelperPermissionState, pane)();
      if (grant !== 'requested' && grant !== 'rejected') consumedHelperNotices.delete(notice.id);
      // Still denied after the one helper action: fall back to the settings pane.
      if (outcome.status !== 'granted' && deps.available()) {
        return { status: await deps.open(pane) ? 'opened' : 'not_available', outcome };
      }
      return settle(deps, notice, { status: grant === 'requested' ? 'checked' : grant, outcome });
    }
    if (request.actionKind === 'request_grant' && isCalendarNotice(notice)) {
      // Same exit as the reminder switch and the connector page: one click token, one dialog, then poll for the answer.
      const asked = await askCalendarFromClick({
        access: () => calendarAccess(deps.passiveBridge ?? null),
        prompt: () => requestGrant(mintClickToken(notice.id, deps.now), { pane: 'calendars' }, deps.grantBridge ?? null, deps.now)
          .catch(() => 'not_available' as const),
        open: deps.open, available: deps.available, sleep: deps.sleep, now: deps.now,
      });
      if (asked.opened) return { status: 'opened', outcome: calendarOutcome(asked.access) };
      return settle(deps, notice, { status: 'checked', outcome: calendarOutcome(asked.access) });
    }
    if (request.actionKind === 'request_grant') {
      const targetBundleId = automationBundleId(notice.target?.id);
      const probe = noticeProbe(deps, notice, request.payload.pane);
      if (!probe) return { status: 'rejected' };
      // Only "undecided" can show the system dialog. Refused (-1743) never prompts again and a target that isn't running (-600)
      // can't be asked, so both go straight to Settings instead of a click that does nothing (ADR-090 §3 row 1).
      // ponytail: not_running opens Settings rather than launching the target first; launch-then-ask when S4 owns Apple events.
      if (request.payload.pane === 'automation') {
        const before = await probe();
        if ((before.status === 'denied' || before.status === 'not_running') && deps.available()) {
          return { status: await deps.open('automation') ? 'opened' : 'not_available', outcome: before };
        }
      }
      const token = mintClickToken(notice.id, deps.now);
      const grant = await requestGrant(token, { ...request.payload, targetBundleId }, deps.grantBridge ?? null, deps.now);
      return settle(deps, notice, { status: grant === 'requested' ? 'checked' : grant, outcome: await probe() });
    }
    if (!deps.available()) return { status: 'not_available' };
    return { status: await deps.open(request.payload.pane) ? 'opened' : 'not_available' };
  },
});

function buildDefaultDependencies(): EnvAssistDependencies {
  const client = resolveShellBridgeClientFromEnv();
  if (!client) {
    return { ...defaults, passiveBridge: null, grantBridge: null, cuaHelperGrantBridge: createCuaHelperGrantBridge() };
  }
  return {
    ...defaults,
    cuaHelperGrantBridge: createCuaHelperGrantBridge(),
    passiveBridge: createShellPassiveBridge(client),
    grantBridge: createDefaultGrantBridge(client),
  };
}

/**
 * Connector page「修复权限」on the calendar (the user's click, via connector IPC): the same calendar exit as the card
 * and the reminder switch — one click token, one dialog, poll; refused opens Privacy → Calendars; granted settles every card.
 */
export async function grantCalendarFromConnectorClick(): Promise<void> {
  const deps = buildDefaultDependencies();
  const asked = await askCalendarFromClick({
    access: () => calendarAccess(deps.passiveBridge ?? null),
    prompt: () => requestGrant(mintClickToken('connector:calendar'), { pane: 'calendars' }, deps.grantBridge ?? null)
      .catch(() => 'not_available' as const),
    open: deps.open, available: deps.available,
  });
  if (asked.access === 'granted') await settleCalendarGranted('connector_repair');
}

/**
 * ADR-090 修订（N-ENV-ASSIST-FOREGROUND-DIRECT-PROMPT）：用户本人在前台发起的这一轮里，日历工具碰到「未决定」——
 * 用户就在跟前、请求是他自己的，直接弹一次系统框并等答复，不先出卡。凭证仍只在本文件签发；
 * 只有「未决定」才弹（已拒绝/只写/受限不弹，调用方照旧出卡）。调用方负责只在前台、非无人值守、非子代理时调用。
 */
export async function grantCalendarForForegroundRequest(toolCallId: string, signal?: AbortSignal): Promise<CalendarAccess | 'aborted'> {
  const deps = buildDefaultDependencies();
  const asked = await askCalendarOnce({
    access: () => calendarAccess(deps.passiveBridge ?? null),
    prompt: () => requestGrant(mintClickToken(`foreground:${toolCallId}`), { pane: 'calendars' }, deps.grantBridge ?? null)
      .catch(() => 'not_available' as const),
  }, undefined, signal);
  if (asked?.aborted) {
    logger.info('Calendar foreground request: stopped while waiting', { prompted: asked.prompted });
    void asked.completion?.then(async (answer) => {
      if (answer?.access === 'granted') await settleCalendarGranted('foreground_request');
    }).catch((error: unknown) => {
      logger.warn('Calendar foreground request: completion failed', { error: error instanceof Error ? error.message : String(error) });
    });
    return 'aborted';
  }
  const access = asked?.access ?? 'unavailable';
  logger.info('Calendar foreground request: direct dialog', { prompted: asked?.prompted === true, access });
  if (access === 'granted') await settleCalendarGranted('foreground_request');
  return access;
}

/** Opener injection is also used by hosts without a desktop; it never grants permission. */
export function registerEnvAssistHandlers(deps: EnvAssistDependencies = defaults): void {
  const resolved = deps === defaults ? buildDefaultDependencies() : deps;
  installDomainRoutes(ipcHost, routes, resolved);
}
registerEnvAssistHandlers.routes = routes;

/**
 * S3 resume probe for a parked run: the same passive (never-prompting) check the card uses.
 * Distinguishable degrade reasons are logged; 'unavailable' stops the waiter (manual Continue still works).
 */
export const envResumeProbeFactory: EnvResumeProbeFactory = (block) => {
  // Calendar runs (perm_calendars, and perm_automation runs parked before the switch) resume on the EventKit truth.
  if (block.target === 'calendar' && (block.class === 'perm_calendars' || block.class === 'perm_automation')) {
    const client = resolveShellBridgeClientFromEnv();
    const passive = client ? createShellPassiveBridge(client) : null;
    return async () => {
      const access = await calendarAccess(passive);
      return access === 'granted' ? 'green' : access === 'unavailable' ? 'unavailable' : 'red';
    };
  }
  const bundleId = block.class === 'perm_automation' ? automationBundleId(block.target) : undefined;
  if (!bundleId) logger.warn('Env resume probe unavailable', { reason: 'unsupported_target', class: block.class, target: block.target });
  const client = bundleId ? resolveShellBridgeClientFromEnv() : null; // logs env_assist_bridge:no_shell itself
  const probe = bundleId && client ? automationProbe(createShellPassiveBridge(client), bundleId) : null;
  return async () => {
    if (!probe) return 'unavailable';
    const { status } = await probe();
    return status === 'granted' ? 'green' : status === 'unavailable' ? 'unavailable' : 'red';
  };
};
