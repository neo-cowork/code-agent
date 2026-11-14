import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_ASSIST_BRIDGE_TIMEOUT_MS, ENV_ASSIST_CLICK_TTL_MS } from '../../../../../src/shared/constants/envAssist';
import type { EnvAssistNotice } from '../../../../../src/shared/contract/envAssist';
import type { Message } from '../../../../../src/shared/contract';
import type { registerEnvAssistHandlers as RegisterEnvAssistHandlers } from '../../../../../src/host/ipc/envAssist.ipc';
import type * as Grants from '../../../../../src/host/permissions/envAssist/grants/requestGrant';
import {
  accessibilityProbe,
  automationProbe,
  inputMonitoringProbe,
  screenRecordingProbe,
} from '../../../../../src/host/permissions/envAssist/probes/passiveProbes';
import { createShellPassiveBridge } from '../../../../../src/host/permissions/envAssist/probes/shellPassiveBridge';
import type {
  captureShellBridgeEnv as CaptureShellBridgeEnv,
  resolveShellBridgeClientFromEnv as ResolveShellBridgeClientFromEnv,
} from '../../../../../src/host/permissions/envAssist/shellBridge/client';
import type { HandlerFn } from '../../../../../src/host/platform';

const logs = vi.hoisted(() => ({
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

const startupProbe = vi.hoisted(() => vi.fn());
vi.mock('../../../../../src/web/devSlotRuntime', () => ({
  detectDevSlotRuntime: startupProbe,
}));

const storage = vi.hoisted(() => ({
  notices: new Map<string, EnvAssistNotice>(),
  openPane: vi.fn(async (_pane: string) => true),
  available: vi.fn(() => true),
}));

vi.mock('../../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...await importOriginal<object>(),
  createLogger: () => logs,
}));

vi.mock('../../../../../src/host/permissions/envAssist/settingsPane', () => ({
  canOpenEnvSettings: () => storage.available(),
  openEnvSettings: (pane: string) => storage.openPane(pane),
}));

vi.mock('../../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => ({
      prepare: () => ({
        get: (messageId: string) => {
          const noticeId = messageId.startsWith('env-assist:') ? messageId.slice('env-assist:'.length) : '';
          const found = storage.notices.get(noticeId);
          return found ? { session_id: found.sessionId } : undefined;
        },
      }),
    }),
  }),
}));

vi.mock('../../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getMessages: async (sessionId: string): Promise<Message[]> =>
      [...storage.notices.values()]
        .filter((n) => n.sessionId === sessionId)
        .map((n) => ({
          id: `env-assist:${n.id}`,
          role: 'assistant' as const,
          content: '',
          timestamp: n.updatedAt,
          metadata: { envAssist: n },
        })),
  }),
}));

interface ShellStub {
  url: string;
  port: number;
  token: string;
  passiveHits: number;
  grantHits: number;
  passiveByPath: Record<string, number>;
  grantByPath: Record<string, number>;
  state: {
    trusted: boolean;
    screenGranted: boolean;
    iohidCode: 0 | 1 | 2;
    automationCode: 0 | -1743 | -1744 | -600;
    forceStatus: number | null;
    hang: boolean;
  };
  close: () => Promise<void>;
}

async function startShellStub(token = 'a'.repeat(64)): Promise<ShellStub> {
  const passiveByPath: Record<string, number> = {};
  const grantByPath: Record<string, number> = {};
  const state: ShellStub['state'] = {
    trusted: false,
    screenGranted: false,
    iohidCode: 2,
    automationCode: -1744,
    forceStatus: null,
    hang: false,
  };
  const openSockets = new Set<import('node:net').Socket>();

  const stub: ShellStub = {
    url: '',
    port: 0,
    token,
    passiveHits: 0,
    grantHits: 0,
    passiveByPath,
    grantByPath,
    state,
    close: async () => {},
  };

  const server = http.createServer((req, res) => {
    if (state.hang) {
      return;
    }
    const expectedHost = `127.0.0.1:${stub.port}`;
    if (req.headers.host !== expectedHost) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_host' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }
    if (state.forceStatus !== null) {
      res.writeHead(state.forceStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forced_status' }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${stub.token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 1024) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'body_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      const parsed = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
      const path = req.url ?? '';

      if (path.startsWith('/v1/passive/')) {
        stub.passiveHits++;
        passiveByPath[path] = (passiveByPath[path] ?? 0) + 1;
        switch (path) {
          case '/v1/passive/accessibility':
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ trusted: state.trusted }));
            return;
          case '/v1/passive/screen':
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ granted: state.screenGranted }));
            return;
          case '/v1/passive/input':
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: state.iohidCode }));
            return;
          case '/v1/passive/automation':
            if (typeof parsed.targetBundleId !== 'string' || !parsed.targetBundleId.trim()) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid_request_body' }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: state.automationCode }));
            return;
        }
      }

      if (path.startsWith('/v1/grant/')) {
        stub.grantHits++;
        grantByPath[path] = (grantByPath[path] ?? 0) + 1;
        switch (path) {
          case '/v1/grant/accessibility':
            state.trusted = true;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ requested: true, trusted: true }));
            return;
          case '/v1/grant/screen':
            state.screenGranted = true;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ requested: true, granted: true }));
            return;
          case '/v1/grant/input':
            state.iohidCode = 0;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ requested: true, granted: true }));
            return;
          case '/v1/grant/automation':
            if (typeof parsed.targetBundleId !== 'string' || !parsed.targetBundleId.trim()) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid_request_body' }));
              return;
            }
            state.automationCode = 0;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ requested: true, code: 0 }));
            return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
  });

  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  stub.port = addr.port;
  stub.url = `http://127.0.0.1:${addr.port}`;
  stub.close = async () => {
    for (const socket of openSockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return stub;
}

function putNotice(notice: EnvAssistNotice): EnvAssistNotice {
  storage.notices.set(notice.id, notice);
  return notice;
}

describe('shell loopback bridge & production registerEnvAssistHandlers defaults', () => {
  const savedUrl = process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL;
  const savedToken = process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN;
  const originalPlatform = process.platform;
  let handler: HandlerFn | undefined;
  const activeStubs: ShellStub[] = [];
  const tempDirs: string[] = [];

  let registerEnvAssistHandlers: typeof RegisterEnvAssistHandlers;
  let captureShellBridgeEnv: typeof CaptureShellBridgeEnv;
  let resolveShellBridgeClientFromEnv: typeof ResolveShellBridgeClientFromEnv;
  let grants: typeof Grants;

  async function loadProductionModules(): Promise<void> {
    // Exercise fresh launch state without exposing a credential reset in production.
    vi.resetModules();
    ({ captureShellBridgeEnv, resolveShellBridgeClientFromEnv } = await import(
      '../../../../../src/host/permissions/envAssist/shellBridge/client'
    ));
    ({ registerEnvAssistHandlers } = await import('../../../../../src/host/ipc/envAssist.ipc'));
    grants = await import('../../../../../src/host/permissions/envAssist/grants/requestGrant');
    const { ipcHost } = await import('../../../../../src/host/platform');
    vi.spyOn(ipcHost, 'handle').mockImplementation((_channel, fn) => {
      handler = fn;
    });
  }

  beforeEach(async () => {
    delete process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL;
    delete process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN;
    await loadProductionModules();
    logs.warn.mockClear();
    storage.notices.clear();
    storage.openPane.mockClear();
    storage.available.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    startupProbe.mockReset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (savedUrl === undefined) delete process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL;
    else process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL = savedUrl;
    if (savedToken === undefined) delete process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN;
    else process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN = savedToken;
    while (activeStubs.length > 0) {
      const s = activeStubs.pop()!;
      await s.close();
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('wires production registerEnvAssistHandlers() defaults through the shell endpoint, scrubs bridge vars from process.env, and degrades with distinguishable warns', async () => {
    const stub = await startShellStub();
    activeStubs.push(stub);

    process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL = stub.url;
    process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN = stub.token;

    // Production zero-arg registration captures bridge vars into module-private memory and scrubs process.env.
    expect(logs.warn).not.toHaveBeenCalled();
    registerEnvAssistHandlers();
    expect(registerEnvAssistHandlers.routes.actions.act).toBeTypeOf('function');
    expect(process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN).toBeUndefined();
    expect(process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL).toBeUndefined();

    // Even with process.env scrubbed, resolveShellBridgeClientFromEnv() uses captured values
    // and passive diagnosis probes hit ONLY /v1/passive/* while keeping /v1/grant/* counter at 0.
    const passiveBridge = createShellPassiveBridge(resolveShellBridgeClientFromEnv()!);
    expect(await accessibilityProbe(passiveBridge)()).toEqual({ status: 'denied' });
    expect(await screenRecordingProbe(passiveBridge)()).toEqual({ status: 'denied' });
    expect(await inputMonitoringProbe(passiveBridge)()).toEqual({ status: 'undecided' });
    expect(await automationProbe(passiveBridge, 'com.apple.Calendar')()).toEqual({ status: 'undecided' });
    expect(stub.passiveHits).toBe(4);
    expect(stub.grantHits).toBe(0);

    // Production act(request_grant) across all four panes reaches /v1/grant/* once per click + re-probes /v1/passive/*.
    const cases: Array<{
      id: string;
      klass: EnvAssistNotice['class'];
      pane: 'accessibility' | 'screenCapture' | 'inputMonitoring' | 'automation';
      target?: { id: string; labelKey: string };
      grantPath: string;
      passivePath: string;
    }> = [
      { id: 'n-ax', klass: 'perm_accessibility', pane: 'accessibility', grantPath: '/v1/grant/accessibility', passivePath: '/v1/passive/accessibility' },
      { id: 'n-sc', klass: 'perm_screen_recording', pane: 'screenCapture', grantPath: '/v1/grant/screen', passivePath: '/v1/passive/screen' },
      { id: 'n-im', klass: 'perm_input_monitoring', pane: 'inputMonitoring', grantPath: '/v1/grant/input', passivePath: '/v1/passive/input' },
      {
        id: 'n-ae',
        klass: 'perm_automation',
        pane: 'automation',
        target: { id: 'com.apple.Calendar', labelKey: 'env.target.calendar' },
        grantPath: '/v1/grant/automation',
        passivePath: '/v1/passive/automation',
      },
    ];

    stub.passiveHits = 0;
    for (const item of cases) {
      putNotice({
        id: item.id,
        sessionId: 's-prod',
        runId: 'r-prod',
        class: item.klass,
        phase: 'needs_user',
        sentenceKey: 'env.sentence',
        ...(item.target ? { target: item.target } : {}),
        action: { kind: 'request_grant', labelKey: 'env.allow', payload: { pane: item.pane } },
        resume: { mode: 'manual' },
        updatedAt: 1,
      });
      const beforeGrant = stub.grantHits;
      const res = await handler!({} as never, {
        action: 'act',
        payload: { noticeId: item.id, actionKind: 'request_grant', payload: { pane: item.pane } },
      });
      expect(res).toEqual({
        success: true,
        data: { status: 'checked', outcome: { status: 'granted' } },
      });
      expect(stub.grantHits - beforeGrant).toBe(1);
      expect(stub.grantByPath[item.grantPath]).toBe(1);
      expect(stub.passiveByPath[item.passivePath]).toBe(2);
    }
    expect(stub.grantHits).toBe(4);
    expect(stub.passiveHits).toBe(4);
    process.stdout.write(
      `[production defaults] request_grant×4 status=checked grantHits=${stub.grantHits} passiveHits=${stub.passiveHits}\n`,
    );

    // Web build / no shell (env vars absent, fresh uncaptured state): logs env_assist_bridge:no_shell,
    // degrades to null bridges, and open_settings_pane still opens System Settings via the existing path.
    delete process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL;
    delete process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN;
    logs.warn.mockClear();
    await loadProductionModules();
    registerEnvAssistHandlers();
    expect(logs.warn).toHaveBeenCalledWith('env_assist_bridge:no_shell');
    const noShellWarn = String(logs.warn.mock.calls[0]?.[0]);

    putNotice({
      id: 'n-open',
      sessionId: 's-prod',
      runId: 'r-prod',
      class: 'perm_accessibility',
      phase: 'needs_user',
      sentenceKey: 'env.sentence',
      action: { kind: 'open_settings_pane', labelKey: 'env.allow', payload: { pane: 'accessibility' } },
      resume: { mode: 'manual' },
      updatedAt: 2,
    });
    expect(
      await handler!({} as never, {
        action: 'act',
        payload: { noticeId: 'n-open', actionKind: 'open_settings_pane', payload: { pane: 'accessibility' } },
      }),
    ).toEqual({ success: true, data: { status: 'opened' } });
    expect(storage.openPane).toHaveBeenCalledExactlyOnceWith('accessibility');

    const degradedGrant = await handler!({} as never, {
      action: 'act',
      payload: { noticeId: 'n-ax', actionKind: 'request_grant', payload: { pane: 'accessibility' } },
    });
    expect(degradedGrant).toEqual({
      success: true,
      data: {
        status: 'not_available',
        outcome: { status: 'unavailable', reason: 'probe_unavailable:accessibility:no_native_bridge' },
      },
    });
    expect(stub.grantHits).toBe(4);

    // Also capture the other two distinct bridge warn reasons via the explicit env parameter.
    logs.warn.mockClear();
    const wrongAuthProbe = accessibilityProbe(
      createShellPassiveBridge(
        resolveShellBridgeClientFromEnv({
          CODE_AGENT_ENV_ASSIST_BRIDGE_URL: stub.url,
          CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN: 'wrong-token',
        })!,
      ),
    );
    expect(await wrongAuthProbe()).toEqual({
      status: 'unavailable',
      reason: 'probe_unavailable:accessibility:native_error',
    });
    expect(logs.warn).toHaveBeenCalledWith('env_assist_bridge:bridge_auth_rejected');
    const authRejectedWarn = String(logs.warn.mock.calls[0]?.[0]);

    const closedStub = await startShellStub();
    const closedUrl = closedStub.url;
    await closedStub.close();
    logs.warn.mockClear();
    const unreachableProbe = accessibilityProbe(
      createShellPassiveBridge(
        resolveShellBridgeClientFromEnv({
          CODE_AGENT_ENV_ASSIST_BRIDGE_URL: closedUrl,
          CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN: stub.token,
        })!,
      ),
    );
    expect(await unreachableProbe()).toEqual({
      status: 'unavailable',
      reason: 'probe_unavailable:accessibility:native_error',
    });
    expect(logs.warn).toHaveBeenCalledWith('env_assist_bridge:bridge_unreachable');
    const unreachableWarn = String(logs.warn.mock.calls[0]?.[0]);

    expect(new Set([noShellWarn, authRejectedWarn, unreachableWarn]).size).toBe(3);
    process.stdout.write(
      `[distinct warn reasons] 1=${noShellWarn} 2=${authRejectedWarn} 3=${unreachableWarn}\n`,
    );
  });

  it('captures only once and scrubs reintroduced env vars without replacing the launch credentials', async () => {
    const stub = await startShellStub();
    activeStubs.push(stub);
    process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL = stub.url;
    process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN = stub.token;
    captureShellBridgeEnv();
    expect(process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN).toBeUndefined();
    expect(process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL).toBeUndefined();

    process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL = 'http://127.0.0.1:1';
    process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN = 'reintroduced-test-value';
    captureShellBridgeEnv();
    expect(process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN).toBeUndefined();
    expect(process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL).toBeUndefined();
    const bridge = createShellPassiveBridge(resolveShellBridgeClientFromEnv()!);
    expect(await accessibilityProbe(bridge)()).toEqual({ status: 'denied' });
    expect(stub.passiveHits).toBe(1);
    expect(stub.grantHits).toBe(0);
  });

  it('webServer startup (webEnvInit) captures and deletes bridge env vars before any child spawn while probes and request_grant still reach the stub', async () => {
    const stub = await startShellStub();
    activeStubs.push(stub);

    const savedWebEnv = {
      CODE_AGENT_DATA_DIR: process.env.CODE_AGENT_DATA_DIR,
      WEB_PORT: process.env.WEB_PORT,
      CODE_AGENT_WEB_PORT: process.env.CODE_AGENT_WEB_PORT,
      CODE_AGENT_CLI_MODE: process.env.CODE_AGENT_CLI_MODE,
      CODE_AGENT_WEB_MODE: process.env.CODE_AGENT_WEB_MODE,
    };
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-bridge-webenv-'));
    tempDirs.push(fakeHome);

    try {
      process.env.CODE_AGENT_DATA_DIR = path.join(fakeHome, '.code-agent');
      process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL = stub.url;
      process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN = stub.token;

      startupProbe.mockImplementation(() => {
        // This is webEnvInit's earliest spawn-capable runtime probe, before IPC/tools/MCP/plugins.
        expect(process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN).toBeUndefined();
        expect(process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL).toBeUndefined();
        const child = spawnSync(process.execPath, ['-e', `
          process.exit(
            process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN === undefined &&
            process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL === undefined ? 0 : 1
          );
        `]);
        expect(child.status).toBe(0);
        return { isGitWorktree: () => false, isSlotFree: () => true };
      });
      await import('../../../../../src/web/webEnvInit');
      expect(startupProbe).toHaveBeenCalledOnce();
      process.stdout.write('[startup capture] earliest runtime probe child inherited neither bridge var\n');

      // Immediately after webEnvInit (before tools, MCP, plugins, or registerEnvAssistHandlers run),
      // both env vars are deleted from process.env.
      expect(process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN).toBeUndefined();
      expect(process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL).toBeUndefined();

      // Subsequent registration and passive probes still reach the stub using the captured values.
      registerEnvAssistHandlers();

      const passiveBridge = createShellPassiveBridge(resolveShellBridgeClientFromEnv()!);
      expect(await accessibilityProbe(passiveBridge)()).toEqual({ status: 'denied' });
      expect(stub.passiveHits).toBe(1);
      expect(stub.grantHits).toBe(0);

      putNotice({
        id: 'n-startup-capture',
        sessionId: 's-startup',
        runId: 'r-startup',
        class: 'perm_screen_recording',
        phase: 'needs_user',
        sentenceKey: 'env.sentence',
        action: { kind: 'request_grant', labelKey: 'env.allow', payload: { pane: 'screenCapture' } },
        resume: { mode: 'manual' },
        updatedAt: 1,
      });
      const grantRes = await handler!({} as never, {
        action: 'act',
        payload: { noticeId: 'n-startup-capture', actionKind: 'request_grant', payload: { pane: 'screenCapture' } },
      });
      expect(grantRes).toEqual({
        success: true,
        data: { status: 'checked', outcome: { status: 'granted' } },
      });
      expect(stub.grantHits).toBe(1);
    } finally {
      for (const [key, val] of Object.entries(savedWebEnv)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
    }
  });

  it('fault injection through act: missing, replayed, and expired click tokens keep /v1/grant/* hits at 0; wrong token and unreachable/timed-out endpoint keep grant hits at 0 across all passive probes', async () => {
    const stub = await startShellStub();
    activeStubs.push(stub);
    process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL = stub.url;
    process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN = stub.token;

    putNotice({
      id: 'n-fault',
      sessionId: 's-fault',
      runId: 'r-fault',
      class: 'perm_automation',
      phase: 'needs_user',
      sentenceKey: 'env.sentence.calendar',
      target: { id: 'com.apple.Calendar', labelKey: 'env.target.calendar' },
      action: { kind: 'request_grant', labelKey: 'env.allow.calendar', payload: { pane: 'automation' } },
      resume: { mode: 'manual' },
      updatedAt: 1,
    });

    registerEnvAssistHandlers();
    expect(process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN).toBeUndefined();
    expect(process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL).toBeUndefined();

    const actPayload = {
      noticeId: 'n-fault',
      actionKind: 'request_grant' as const,
      payload: { pane: 'automation' as const },
    };

    // 1. Missing click token injected at the mint boundary inside act -> /v1/grant/* counter stays 0.
    const mintSpy = vi.spyOn(grants, 'mintClickToken');
    mintSpy.mockReturnValueOnce(undefined as never);
    const missingRes = await handler!({} as never, { action: 'act', payload: actPayload });
    expect(missingRes).toEqual({
      success: true,
      data: { status: 'rejected', outcome: { status: 'undecided' } },
    });
    expect(stub.grantHits).toBe(0);
    process.stdout.write(`[fault missing token] status=rejected grantHits=${stub.grantHits}\n`);

    // Mint + consume one real token via a real act click, then reset counter to test replay through act.
    const validRes = await handler!({} as never, { action: 'act', payload: actPayload });
    expect(validRes).toMatchObject({ success: true, data: { status: 'checked' } });
    expect(stub.grantHits).toBe(1);
    const consumedToken = mintSpy.mock.results[1]?.value;
    expect(consumedToken).toBeDefined();
    stub.grantHits = 0;
    stub.state.automationCode = -1743;

    // 2. Replayed click token through act -> /v1/grant/* counter stays 0.
    mintSpy.mockReturnValueOnce(consumedToken);
    const replayRes = await handler!({} as never, { action: 'act', payload: actPayload });
    expect(replayRes).toEqual({
      success: true,
      data: { status: 'rejected', outcome: { status: 'denied' } },
    });
    expect(stub.grantHits).toBe(0);
    process.stdout.write(`[fault replayed token] status=rejected grantHits=${stub.grantHits}\n`);
    mintSpy.mockRestore();

    // 3. Expired click token (age === ENV_ASSIST_CLICK_TTL_MS) through act -> /v1/grant/* counter stays 0.
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(10_000 + ENV_ASSIST_CLICK_TTL_MS);
    const expiredRes = await handler!({} as never, { action: 'act', payload: actPayload });
    expect(expiredRes).toEqual({
      success: true,
      data: { status: 'rejected', outcome: { status: 'denied' } },
    });
    expect(stub.grantHits).toBe(0);
    process.stdout.write(
      `[fault expired token] ttlMs=${ENV_ASSIST_CLICK_TTL_MS} status=rejected grantHits=${stub.grantHits}\n`,
    );
    nowSpy.mockRestore();

    // 4. Wrong token (401 and 403) via explicit env parameter: all four passive probes return unavailable with warn and grantHits stays 0.
    const wrongAuthBridge = createShellPassiveBridge(
      resolveShellBridgeClientFromEnv({
        CODE_AGENT_ENV_ASSIST_BRIDGE_URL: stub.url,
        CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN: 'stale-token-after-shell-restart',
      })!,
    );
    const probeEntries = [
      ['accessibility', accessibilityProbe(wrongAuthBridge)],
      ['screen_recording', screenRecordingProbe(wrongAuthBridge)],
      ['input_monitoring', inputMonitoringProbe(wrongAuthBridge)],
      ['automation', automationProbe(wrongAuthBridge, 'com.apple.Calendar')],
    ] as const;

    for (const [name, runProbe] of probeEntries) {
      logs.warn.mockClear();
      expect(await runProbe()).toEqual({
        status: 'unavailable',
        reason: `probe_unavailable:${name}:native_error`,
      });
      expect(logs.warn).toHaveBeenCalledWith('env_assist_bridge:bridge_auth_rejected');
      expect(logs.warn).toHaveBeenCalledWith(`probe_unavailable:${name}:native_error`);
    }
    stub.state.forceStatus = 403;
    logs.warn.mockClear();
    expect(await accessibilityProbe(wrongAuthBridge)()).toEqual({
      status: 'unavailable',
      reason: 'probe_unavailable:accessibility:native_error',
    });
    expect(logs.warn).toHaveBeenCalledWith('env_assist_bridge:bridge_auth_rejected');
    stub.state.forceStatus = null;
    expect(stub.grantHits).toBe(0);
    process.stdout.write(`[fault wrong token 401/403] probes=4×unavailable grantHits=${stub.grantHits}\n`);

    // 5. Unreachable endpoint (connection refused + timeout past ENV_ASSIST_BRIDGE_TIMEOUT_MS):
    //    all four passive probes return unavailable with warn and grantHits stays 0.
    const deadStub = await startShellStub();
    const deadUrl = deadStub.url;
    await deadStub.close();
    const deadBridge = createShellPassiveBridge(
      resolveShellBridgeClientFromEnv({
        CODE_AGENT_ENV_ASSIST_BRIDGE_URL: deadUrl,
        CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN: stub.token,
      })!,
    );
    for (const [name, runProbe] of [
      ['accessibility', accessibilityProbe(deadBridge)],
      ['screen_recording', screenRecordingProbe(deadBridge)],
      ['input_monitoring', inputMonitoringProbe(deadBridge)],
      ['automation', automationProbe(deadBridge, 'com.apple.Calendar')],
    ] as const) {
      logs.warn.mockClear();
      expect(await runProbe()).toEqual({
        status: 'unavailable',
        reason: `probe_unavailable:${name}:native_error`,
      });
      expect(logs.warn).toHaveBeenCalledWith('env_assist_bridge:bridge_unreachable');
      expect(logs.warn).toHaveBeenCalledWith(`probe_unavailable:${name}:native_error`);
    }
    expect(stub.grantHits).toBe(0);

    // Timeout path using ENV_ASSIST_BRIDGE_TIMEOUT_MS against a hanging endpoint.
    stub.state.hang = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    logs.warn.mockClear();
    const hangingBridge = createShellPassiveBridge(
      resolveShellBridgeClientFromEnv({
        CODE_AGENT_ENV_ASSIST_BRIDGE_URL: stub.url,
        CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN: stub.token,
      })!,
    );
    const pendingProbe = accessibilityProbe(hangingBridge)();
    await vi.advanceTimersByTimeAsync(ENV_ASSIST_BRIDGE_TIMEOUT_MS);
    expect(await pendingProbe).toEqual({
      status: 'unavailable',
      reason: 'probe_unavailable:accessibility:native_error',
    });
    expect(logs.warn).toHaveBeenCalledWith('env_assist_bridge:bridge_unreachable');
    expect(stub.grantHits).toBe(0);
    process.stdout.write(
      `[fault unreachable+timeout] timeoutMs=${ENV_ASSIST_BRIDGE_TIMEOUT_MS} probes=unavailable grantHits=${stub.grantHits}\n`,
    );
  });
});
