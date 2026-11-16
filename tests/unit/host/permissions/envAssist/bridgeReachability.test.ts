// Evidence class: hermetic-protocol (real loopback HTTP bridge + production notice entry). Not real-device proof.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_ASSIST_BRIDGE_PROBE_TIMEOUT_MS } from '../../../../../src/shared/constants/envAssist';

const TEST_TOKEN = 'expected-test-token';
const PROBE_PATH = '/v1/passive/accessibility';
const logs = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }));

vi.mock('../../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...await importOriginal<object>(),
  createLogger: () => logs,
}));
vi.mock('../../../../../src/host/permissions/envAssist/settingsPane', () => ({ canOpenEnvSettings: () => true }));
vi.mock('../../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getMessages: async () => [], addMessageToSession: async () => undefined }),
}));

type Publish = typeof import('../../../../../src/host/permissions/envAssist/toolNotice').publishEnvAssistToolNotice;

interface FakeBridge {
  port: number;
  url: string;
  requests: string[];
  firstRequest: Promise<void>;
  close: () => Promise<void>;
}

const activeBridges: FakeBridge[] = [];
const savedUrl = process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL;
const savedToken = process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN;
const savedHandshake = process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_HANDSHAKE;
const originalPlatform = process.platform;
let cardSequence = 0;

async function startFakeBridge(options: { port?: number; hang?: boolean; status?: number } = {}): Promise<FakeBridge> {
  const requests: string[] = [];
  let notifyFirstRequest = (): void => {};
  const firstRequest = new Promise<void>((resolve) => { notifyFirstRequest = resolve; });
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    notifyFirstRequest();
    if (options.hang) return;
    const status = req.headers.authorization !== `Bearer ${TEST_TOKEN}` ? 401 : options.status ?? 200;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { trusted: false } : { error: 'test_rejected' }));
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  let listening = true;
  const bridge: FakeBridge = {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    firstRequest,
    close: async () => {
      if (!listening) return;
      listening = false;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
  activeBridges.push(bridge);
  return bridge;
}

function setBridgeEnv(url: string, token = TEST_TOKEN): void {
  process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL = url;
  process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN = token;
}

async function loadPublisher(): Promise<Publish> {
  return (await import('../../../../../src/host/permissions/envAssist/toolNotice')).publishEnvAssistToolNotice;
}

async function cardActionKind(publish: Publish): Promise<string | undefined> {
  cardSequence += 1;
  const result = { success: false, error: 'denied', metadata: { code: 'not_authorized' } } as never;
  await publish({ toolName: 'calendar', result, sessionId: 'bridge-reachability', runId: `run-${cardSequence}`, onEvent: () => undefined });
  return (result as { metadata: { envAssist: { action?: { kind: string } } } }).metadata.envAssist.action?.kind;
}

function capturedWarns(): unknown[] {
  return logs.warn.mock.calls.map((call) => call.length === 1 ? call[0] : call);
}

function printEvidence(label: string, details: Record<string, unknown> = {}): void {
  process.stdout.write(`[bridge-reachability ${label}] ${JSON.stringify({ warns: capturedWarns(), ...details })}\n`);
}

beforeEach(() => {
  vi.resetModules();
  vi.useRealTimers();
  logs.warn.mockClear();
  cardSequence = 0;
  delete process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL;
  delete process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN;
  delete process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_HANDSHAKE;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});

afterEach(async () => {
  vi.useRealTimers();
  while (activeBridges.length > 0) await activeBridges.pop()!.close();
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  if (savedUrl === undefined) delete process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL;
  else process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_URL = savedUrl;
  if (savedToken === undefined) delete process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN;
  else process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN = savedToken;
  if (savedHandshake === undefined) delete process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_HANDSHAKE;
  else process.env.CODE_AGENT_ENV_ASSIST_BRIDGE_HANDSHAKE = savedHandshake;
});

describe('env-assist grant button follows real bridge reachability', () => {
  it('reachable -> request_grant; stopped -> open_settings_pane; same port restarted -> request_grant', async () => {
    const initial = await startFakeBridge();
    setBridgeEnv(initial.url);
    const publish = await loadPublisher();
    const actions: Array<string | undefined> = [];

    actions.push(await cardActionKind(publish));
    expect(actions[0]).toBe('request_grant');

    await initial.close();
    actions.push(await cardActionKind(publish));
    expect(actions[1]).toBe('open_settings_pane');
    expect(logs.warn).toHaveBeenCalledWith('env_assist_bridge:bridge_unreachable');
    expect(logs.warn).toHaveBeenCalledWith('env_assist_bridge:grant_button_withheld', { reason: 'unreachable' });
    const stoppedWarns = capturedWarns();

    const restarted = await startFakeBridge({ port: initial.port });
    actions.push(await cardActionKind(publish));
    expect(actions[2]).toBe('request_grant');
    expect(initial.requests).toEqual([`POST ${PROBE_PATH}`]);
    expect(restarted.requests).toEqual([`POST ${PROBE_PATH}`]);
    printEvidence('stop-restart', { actions, stoppedWarns, initialRequests: initial.requests, restartedRequests: restarted.requests });
  }, 15000);

  it('missing credentials keeps no_shell and no_shell_reason distinct', async () => {
    const publish = await loadPublisher();
    expect(await cardActionKind(publish)).toBe('open_settings_pane');
    expect(logs.warn).toHaveBeenCalledWith('env_assist_bridge:no_shell');
    expect(logs.warn).toHaveBeenCalledWith('env_assist_bridge:no_shell_reason', { reason: 'handshake_flag_missing' });
    expect(logs.warn).not.toHaveBeenCalledWith('env_assist_bridge:grant_button_withheld', expect.anything());
    printEvidence('no-shell');
  });

  it.each([
    { status: 401, token: 'stale-test-token' },
    { status: 403, token: TEST_TOKEN },
  ])('$status rejects the grant button with an auth_rejected trace', async ({ status, token }) => {
    const bridge = await startFakeBridge({ status });
    setBridgeEnv(bridge.url, token);
    const publish = await loadPublisher();
    expect(await cardActionKind(publish)).toBe('open_settings_pane');
    expect(bridge.requests).toEqual([`POST ${PROBE_PATH}`]);
    expect(logs.warn).toHaveBeenCalledWith('env_assist_bridge:bridge_auth_rejected');
    expect(logs.warn).toHaveBeenCalledWith('env_assist_bridge:grant_button_withheld', { reason: 'auth_rejected' });
    printEvidence(`http-${status}`);
  });

  it('a hung bridge resolves the card at the short probe timeout with a timeout trace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const bridge = await startFakeBridge({ hang: true });
    setBridgeEnv(bridge.url);
    const publish = await loadPublisher();
    const pendingCard = cardActionKind(publish);
    await bridge.firstRequest;
    await vi.advanceTimersByTimeAsync(ENV_ASSIST_BRIDGE_PROBE_TIMEOUT_MS);

    expect(await pendingCard).toBe('open_settings_pane');
    expect(bridge.requests).toEqual([`POST ${PROBE_PATH}`]);
    expect(logs.warn).toHaveBeenCalledWith('env_assist_bridge:bridge_unreachable');
    expect(logs.warn).toHaveBeenCalledWith('env_assist_bridge:grant_button_withheld', { reason: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
    printEvidence('timeout', { advancedMs: ENV_ASSIST_BRIDGE_PROBE_TIMEOUT_MS });
  });
});
