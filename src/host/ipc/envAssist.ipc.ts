import type { EnvAssistNotice, EnvAssistActResult } from '../../shared/contract/envAssist';
import { EnvAssistSchemas } from '../../shared/ipc/schemas/envAssist';
import { ipcHost } from '../platform';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { getDatabase } from '../services/core/databaseService';
import { getSessionManager } from '../services/infra/sessionManager';
import { canOpenEnvSettings, openEnvSettings } from '../permissions/envAssist/settingsPane';

import { mintClickToken, requestGrant } from '../permissions/envAssist/grants/requestGrant';
import { accessibilityProbe, automationProbe, screenRecordingProbe } from '../permissions/envAssist/probes/passiveProbes';

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
  now?: () => number;
  available: () => boolean;
  open: (pane: string) => Promise<boolean>;
  findNotice: (id: string) => Promise<EnvAssistNotice | undefined>;
}

const defaults: EnvAssistDependencies = { available: canOpenEnvSettings, open: openEnvSettings, findNotice };
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
    if (request.actionKind === 'request_grant') {
      if (request.payload.pane === 'automation' && !notice.target?.id) return { status: 'rejected' };
      const token = mintClickToken(notice.id, deps.now);
      const grant = await requestGrant(token, { ...request.payload, targetBundleId: notice.target?.id }, deps.grantBridge ?? null, deps.now);
      const bridge = deps.passiveBridge ?? null;
      const probe = request.payload.pane === 'accessibility' ? accessibilityProbe(bridge)
        : request.payload.pane === 'screenCapture' ? screenRecordingProbe(bridge)
          : automationProbe(bridge, notice.target?.id ?? '');
      const outcome = await probe();
      return { status: grant === 'requested' ? 'checked' : grant, outcome };
    }
    if (!deps.available()) return { status: 'not_available' };
    return { status: await deps.open(request.payload.pane) ? 'opened' : 'not_available' };
  },
});

/** Opener injection is also used by hosts without a desktop; it never grants permission. */
export function registerEnvAssistHandlers(deps: EnvAssistDependencies = defaults): void {
  installDomainRoutes(ipcHost, routes, deps);
}
registerEnvAssistHandlers.routes = routes;
