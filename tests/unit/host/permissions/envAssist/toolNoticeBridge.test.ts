import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolResult } from '../../../../../src/shared/contract';
import type { DatabaseService } from '../../../../../src/host/services/core/databaseService';

vi.unmock('electron');

const logs = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const openSettings = vi.hoisted(() => vi.fn(async () => {
  throw new Error('Unexpected System Settings launch');
}));
vi.mock('../../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...await importOriginal<object>(),
  createLogger: () => logs,
}));
vi.mock('../../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));
vi.mock('../../../../../src/host/permissions/envAssist/settingsPane', () => ({
  canOpenEnvSettings: () => true,
  openEnvSettings: openSettings,
}));

const mailFailure = {
  toolName: 'mail', metadata: { code: 'not_authorized' }, klass: 'perm_automation',
  target: 'mail', kind: 'request_grant', pane: 'automation',
} as const;
const failures = [
  {
    toolName: 'screenshot', metadata: { failureCause: 'screen_recording_permission' }, klass: 'perm_screen_recording',
    target: 'screen', kind: 'open_settings_pane', pane: 'screenCapture',
  },
  {
    toolName: 'computer_use', metadata: { failureKind: 'permission_denied' }, klass: 'perm_accessibility',
    target: 'computer', kind: 'open_settings_pane', pane: 'accessibility',
  },
  mailFailure,
  {
    toolName: 'reminders_create', metadata: { code: 'not_authorized' }, klass: 'perm_automation',
    target: 'reminders', kind: 'request_grant', pane: 'automation',
  },
] as const;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const sessionId = 'tool-denial-session';
const reachabilityPath = '/v1/passive/accessibility';
const automationProbePath = '/v1/passive/automation';
const automationGrantPath = '/v1/grant/automation';

describe('tool denial through the production env-assist bridge entries', () => {
  const token = randomBytes(32).toString('hex');
  const requests: Array<{ method: string | undefined; path: string | undefined; authorized: boolean; body: unknown }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const authorized = req.headers.authorization === `Bearer ${token}`;
    requests.push({
      method: req.method,
      path: req.url,
      authorized,
      body: JSON.parse(Buffer.concat(chunks).toString() || '{}') as unknown,
    });
    res.setHeader('Content-Type', 'application/json');
    if (!authorized) { res.writeHead(401).end('{}'); return; }
    if (req.url === reachabilityPath) { res.end('{"trusted":false}'); return; }
    if (req.url === automationProbePath) { res.end('{"code":-1744}'); return; }
    if (req.url === automationGrantPath) { res.end('{"requested":true}'); return; }
    res.writeHead(404).end('{}');
  });

  let dataDir: string;
  let db: DatabaseService;
  let publish: typeof import('../../../../../src/host/permissions/envAssist/toolNotice').publishEnvAssistToolNotice;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'env-assist-notice-'));
    vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
    // Keep the test harness in CLI mode while enabling the web host's SQLite loader.
    vi.stubEnv('CODE_AGENT_WEB_MODE', '1');
    vi.stubEnv('SSH_CONNECTION', undefined);
    vi.stubEnv('SSH_TTY', undefined);
    vi.stubEnv('SSH_CLIENT', undefined);
    vi.stubEnv('AGENT_NEO_BUNDLED_RUNTIME_ROOT', undefined);
    vi.stubEnv('AGENT_NEO_RESOURCE_DIR', undefined);
    const { app } = await import('../../../../../src/host/platform');
    expect(app.getPath('userData')).toBe(dataDir);

    const { getDatabase } = await import('../../../../../src/host/services/core/databaseService');
    db = getDatabase();
    await db.initialize();
    db.createSessionWithId(sessionId, {
      title: 'Tool denial fixture', modelConfig: { provider: 'zhipu', model: 'glm-5' },
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const { captureShellBridgeEnv } = await import('../../../../../src/host/permissions/envAssist/shellBridge/client');
    vi.stubEnv('CODE_AGENT_ENV_ASSIST_BRIDGE_HANDSHAKE', undefined);
    vi.stubEnv('CODE_AGENT_ENV_ASSIST_BRIDGE_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN', token);
    captureShellBridgeEnv();
    ({ publishEnvAssistToolNotice: publish } = await import('../../../../../src/host/permissions/envAssist/toolNotice'));
  }, 30000);

  beforeEach(() => {
    requests.length = 0;
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    db?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  async function publishDenial(failure: Pick<typeof failures[number], 'metadata' | 'klass' | 'target' | 'kind' | 'pane'> & { toolName: string }, runId: string) {
    const result: Pick<ToolResult, 'success' | 'error' | 'metadata'> = {
      success: false, error: 'Permission denied', metadata: { ...failure.metadata },
    };
    await publish({ toolName: failure.toolName, result, sessionId, runId, onEvent: () => undefined });
    return db.getMessages(sessionId).find(({ metadata }) => {
      const notice = metadata?.envAssist;
      return notice?.runId === runId && notice.class === failure.klass && notice.target?.id === failure.target;
    });
  }

  it.each(failures)('persists the $toolName denial with a button', async (failure) => {
    const runId = `denial-${failure.toolName}`;
    const row = await publishDenial(failure, runId);
    const notice = row?.metadata?.envAssist;
    process.stdout.write(`[persisted denial] ${JSON.stringify({
      tool: failure.toolName, messageId: row?.id, class: notice?.class, action: notice?.action,
    })}\n`);
    expect(row).toMatchObject({
      id: `env-assist:${runId}|${failure.klass}|${failure.target}`,
      role: 'assistant',
      metadata: { envAssist: {
        class: failure.klass,
        phase: 'needs_user',
        action: { kind: failure.kind, labelKey: `env.allow.${failure.target}`, payload: { pane: failure.pane } },
      } },
    });
    expect(requests).toEqual(failure.kind === 'request_grant'
      ? [{ method: 'POST', path: reachabilityPath, authorized: true, body: {} }]
      : []);
  });

  it('does not raise the automation card for a reminders read authorization denial', async () => {
    const row = await publishDenial({
      toolName: 'reminders', metadata: { code: 'not_authorized' }, klass: 'perm_automation',
      target: 'reminders', kind: 'request_grant', pane: 'automation',
    }, 'denial-reminders-read-1743');
    expect(row).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it('leaves a denied reminders read untouched: no card, no message, no event, guidance kept', async () => {
    const guidance = '还没有授权 Neo 访问提醒事项，请在能力中心 > 连接器点‘检查’并按提示授权';
    const result: Pick<ToolResult, 'success' | 'error' | 'metadata'> = {
      success: false, error: guidance, metadata: { code: 'not_authorized', accessProbeDenied: true },
    };
    const events: unknown[] = [];
    await publish({ toolName: 'reminders', result, sessionId, runId: 'denial-reminders-read', onEvent: (e) => events.push(e) });
    expect(events).toEqual([]);
    expect(db.getMessages(sessionId).filter((m) => m.id.startsWith('env-assist:denial-reminders-read|'))).toEqual([]);
    expect(result.error).toBe(guidance);
    expect(result.error).toContain('能力中心 > 连接器');
    expect(result.error).toContain('检查');
    expect(requests).toEqual([]);
  });

  it('clicks the persisted mail card with one authorized automation grant', async () => {
    const { registerEnvAssistHandlers } = await import('../../../../../src/host/ipc/envAssist.ipc');
    const { handlers, ipcHost } = await import('../../../../../src/host/platform/ipcRegistry');
    const { channel } = registerEnvAssistHandlers.routes;
    registerEnvAssistHandlers();
    try {
      const row = await publishDenial(mailFailure, 'click-mail');
      const notice = row?.metadata?.envAssist;
      const action = notice?.action;
      expect(action?.kind).toBe('request_grant');
      const handler = handlers.get(channel);
      expect(handler).toBeTypeOf('function');
      const response = await handler!({}, { action: 'act', payload: {
        noticeId: notice?.id, actionKind: action?.kind, payload: action?.payload,
      } });
      const warnings = logs.warn.mock.calls;
      const dialogLogs = [...logs.debug.mock.calls, ...logs.info.mock.calls, ...warnings, ...logs.error.mock.calls]
        .filter(([message]) => /direct dialog/i.test(String(message)));
      process.stdout.write(`[automation click] ${JSON.stringify({ response, warnings, dialogLogs })}\n`);
      process.stdout.write(`[automation request log] ${JSON.stringify(requests)}\n`);

      expect(response).toMatchObject({ success: true, data: { status: 'checked' } });
      const body = { targetBundleId: 'com.apple.mail' };
      expect(requests).toEqual([
        { method: 'POST', path: reachabilityPath, authorized: true, body: {} },
        { method: 'POST', path: automationProbePath, authorized: true, body },
        { method: 'POST', path: automationGrantPath, authorized: true, body },
        { method: 'POST', path: automationProbePath, authorized: true, body },
      ]);
      expect(warnings.map(([message]) => message)).not.toContain('env_assist_bridge:bridge_auth_rejected');
      expect(dialogLogs).toEqual([]);
      expect(openSettings).not.toHaveBeenCalled();
    } finally {
      ipcHost.removeHandler(channel);
    }
  });
});
