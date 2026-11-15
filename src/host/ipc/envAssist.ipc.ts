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
}

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

const defaults: EnvAssistDependencies = { available: canOpenEnvSettings, open: openEnvSettings, findNotice };
/** A cua-helper grant notice is single-use: one click, one helper call. */
const consumedHelperNotices = new Set<string>();
const routes = defineDomainRoutes(EnvAssistSchemas.REQUEST, {
  getAvailability: (deps: EnvAssistDependencies) => ({ available: deps.available() }),
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
      return { status: grant === 'requested' ? 'checked' : grant, outcome };
    }
    if (request.actionKind === 'request_grant') {
      const probe = resolveGrantProbe(request.payload.pane, deps.passiveBridge, notice.target?.id);
      if (!probe) return { status: 'rejected' };
      const token = mintClickToken(notice.id, deps.now);
      const grant = await requestGrant(token, { ...request.payload, targetBundleId: notice.target?.id }, deps.grantBridge ?? null, deps.now);
      const outcome = await probe();
      return { status: grant === 'requested' ? 'checked' : grant, outcome };
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
