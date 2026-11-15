// Real stdin + production entries. Only notice storage is mocked, never the bridge or Bash.
import { mock } from 'node:test';
import type { EnvAssistNotice } from '../../../../../src/shared/contract/envAssist';
import {
  captureShellBridgeEnv,
  resolveShellBridgeClientFromEnv,
} from '../../../../../src/host/permissions/envAssist/shellBridge/client';

const mode = process.argv[2];
captureShellBridgeEnv();
const client = resolveShellBridgeClientFromEnv();
if (mode === 'bash') {
  const { bashModule } = await import('../../../../../src/host/tools/modules/shell/bash');
  const handler = await bashModule.createHandler();
  const result = await handler.execute({ command: 'env', pty: false, run_in_background: false }, {
    sessionId: 'bridge-isolation', workingDir: process.env.HOME!,
    abortSignal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    emit() {}, policyEnforcer: null,
  }, async () => ({ allow: true }));
  process.stdout.write(`BASH ${JSON.stringify({ hasClient: client !== null, result })}\n`);
} else {
  const cases = [
    { pane: 'accessibility', klass: 'perm_accessibility' },
    { pane: 'screenCapture', klass: 'perm_screen_recording' },
    { pane: 'inputMonitoring', klass: 'perm_input_monitoring' },
    { pane: 'automation', klass: 'perm_automation' },
  ] as const;
  const notices: EnvAssistNotice[] = cases.map(({ pane, klass }) => ({
    id: `production-${pane}`, sessionId: 'bridge-session', runId: 'bridge-run',
    class: klass, phase: 'needs_user', sentenceKey: 'env.sentence',
    ...(pane === 'automation' ? { target: { id: 'calendar', labelKey: 'env.target.calendar' } } : {}),
    action: { kind: 'request_grant', labelKey: 'env.allow', payload: { pane } },
    resume: { mode: 'manual' }, updatedAt: 1,
  }));
  mock.module(new URL('../../../../../src/host/services/core/databaseService.ts', import.meta.url).href, {
    namedExports: {
      getDatabase: () => ({ getDb: () => ({ prepare: () => ({ get: (id: string) =>
        notices.some((n) => `env-assist:${n.id}` === id) ? { session_id: 'bridge-session' } : undefined,
      }) }) }),
    },
  });
  mock.module(new URL('../../../../../src/host/services/infra/sessionManager.ts', import.meta.url).href, {
    namedExports: {
      getSessionManager: () => ({ getMessages: async (id: string) => notices.filter((n) => n.sessionId === id).map((n) => ({
        id: `env-assist:${n.id}`, metadata: { envAssist: n },
      })) }),
    },
  });
  const { registerEnvAssistHandlers } = await import('../../../../../src/host/ipc/envAssist.ipc');
  const { handlers } = await import('../../../../../src/host/platform/ipcRegistry');
  registerEnvAssistHandlers();
  const route = handlers.get(registerEnvAssistHandlers.routes.channel)!;
  if (mode === 'diagnostic') {
    const { createShellPassiveBridge } = await import('../../../../../src/host/permissions/envAssist/probes/shellPassiveBridge');
    const probes = await import('../../../../../src/host/permissions/envAssist/probes/passiveProbes');
    const bridge = client ? createShellPassiveBridge(client) : null;
    const outcomes = await Promise.all([
      probes.accessibilityProbe(bridge)(), probes.screenRecordingProbe(bridge)(),
      probes.inputMonitoringProbe(bridge)(), probes.automationProbe(bridge, 'com.apple.iCal')(),
    ]);
    const availability = await route({} as never, { action: 'getAvailability' });
    process.stdout.write(`DIAGNOSTIC ${JSON.stringify({ hasClient: client !== null, outcomes, availability })}\n`);
  } else {
    for (const { pane } of cases) {
      const response = await route({} as never, { action: 'act', payload: {
        noticeId: `production-${pane}`, actionKind: 'request_grant', payload: { pane },
      } });
      process.stdout.write(`CLICK ${JSON.stringify({ pane, response })}\n`);
    }
  }
}
