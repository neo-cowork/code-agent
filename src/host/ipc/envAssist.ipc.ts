import type { EnvAssistNotice, EnvAssistActResult } from '../../shared/contract/envAssist';
import { EnvAssistSchemas } from '../../shared/ipc/schemas/envAssist';
import { ipcHost } from '../platform';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { getDatabase } from '../services/core/databaseService';
import { getSessionManager } from '../services/infra/sessionManager';
import { canOpenEnvSettings, openEnvSettings } from '../permissions/envAssist/settingsPane';

import { createCuaHelperGrantBridge, type CuaHelperGrantBridge } from '../permissions/envAssist/grants/cuaHelperGrantBridge';
import { createDefaultGrantBridge, mintClickToken, requestGrant, requestHelperGrant } from '../permissions/envAssist/grants/requestGrant';
import { accessibilityProbe, automationProbe, inputMonitoringProbe, screenRecordingProbe } from '../permissions/envAssist/probes/passiveProbes';
import { readCuaHelperPermissionState, type CuaHelperPermissionState } from '../permissions/envAssist/cua/helperPermissionState';
import { cuaHelperProbe } from '../permissions/envAssist/probes/cuaHelperProbe';
import { createShellPassiveBridge } from '../permissions/envAssist/probes/shellPassiveBridge';
import type { ReadOnlyProbe } from '../permissions/envAssist/probes/types';
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
}

// Notice targets are Neo's own ids (i18n keys); TCC needs the target app's bundle id.
const AUTOMATION_BUNDLE_IDS: Readonly<Record<string, string>> = {
  calendar: 'com.apple.iCal', mail: 'com.apple.mail', reminders: 'com.apple.reminders',
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
  return result;
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
    const actionPayload = notice?.action?.payload;
    if (notice?.phase !== 'needs_user' || !actionPayload || !('pane' in actionPayload)) return { status: 'rejected' };
    const probe = noticeProbe(deps, notice, actionPayload.pane);
    if (!probe) return { status: 'rejected' };
    return settle(deps, notice, { status: 'checked', outcome: await probe() });
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
