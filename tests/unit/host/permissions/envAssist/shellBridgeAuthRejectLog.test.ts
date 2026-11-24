// 桥回 401/403 时，固定的 bridge_auth_rejected 行保持第一个 warn 不变，紧跟一行结构化
// bridge_auth_rejected_detail（status + 桥自己的机器码），让真机日志一次 grep 区分
// 「用户点了不允许」(403 calendar_not_authorized)、重启后 token 失效 (401)、Host 不对 (403 invalid_host)。
// Evidence class: hermetic-protocol（本机 127.0.0.1 http 桩 + 真实 fetch 客户端，不经 fetch mock）。
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveShellBridgeClientFromEnv } from '../../../../../src/host/permissions/envAssist/shellBridge/client';

const logs = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }));

vi.mock('../../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...await importOriginal<object>(),
  createLogger: () => logs,
}));

interface Stub {
  url: string;
  close: () => Promise<void>;
}

async function startStub(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, port: number) => void,
): Promise<Stub> {
  let port = 0;
  const openSockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => handler(req, res, port));
  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of openSockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// Production entry: resolveShellBridgeClientFromEnv(env, 'darwin').post against the real stub.
async function postToStub(stub: Stub, token = 't'): Promise<Error> {
  const client = resolveShellBridgeClientFromEnv(
    {
      CODE_AGENT_ENV_ASSIST_BRIDGE_URL: stub.url,
      CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN: token,
    },
    'darwin',
  );
  expect(client).not.toBeNull();
  return client!.post('/v1/read/calendars').then(
    () => {
      throw new Error('expected the stub to reject');
    },
    (error: unknown) => error as Error,
  );
}

function expectAuthRejectDetail(detail: { status: number; code: string | undefined }): void {
  // The pre-existing fixed line stays unchanged and stays the FIRST warn call.
  expect(logs.warn.mock.calls[0]).toEqual(['env_assist_bridge:bridge_auth_rejected']);
  // The new structured line goes right after it — nothing else warns on this path.
  expect(logs.warn).toHaveBeenCalledTimes(2);
  expect(logs.warn).toHaveBeenNthCalledWith(
    2,
    'env_assist_bridge:bridge_auth_rejected_detail',
    detail,
  );
  process.stdout.write(`[auth_rejected_detail] ${JSON.stringify(logs.warn.mock.calls)}\n`);
}

describe('shell bridge auth rejection emits status + machine code after the fixed warn line', () => {
  const stubs: Stub[] = [];

  beforeEach(() => logs.warn.mockClear());
  afterEach(async () => {
    while (stubs.length > 0) await stubs.pop()!.close();
  });

  it('401 stale token: logs { status: 401, code: unauthorized } after bridge_auth_rejected', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    stubs.push(stub);

    const error = await postToStub(stub, 'stale-token-after-shell-restart');
    expect(error.message).toBe('env_assist_bridge:bridge_auth_rejected');
    expectAuthRejectDetail({ status: 401, code: 'unauthorized' });
  });

  it('403 calendar_not_authorized (user pressed "Don\'t Allow"): logs { status: 403, code: calendar_not_authorized }', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'calendar_not_authorized', status: 2 }));
    });
    stubs.push(stub);

    const error = await postToStub(stub);
    expect(error.message).toBe('env_assist_bridge:bridge_auth_rejected');
    expectAuthRejectDetail({ status: 403, code: 'calendar_not_authorized' });
  });

  it('403 invalid_host (bridge rejects the Host header): logs { status: 403, code: invalid_host }', async () => {
    // The stub only accepts Host `bridge.local:<port>`; fetch sends `127.0.0.1:<port>` -> invalid_host.
    const stub = await startStub((req, res, port) => {
      if (req.headers.host !== `bridge.local:${port}`) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_host' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    stubs.push(stub);

    const error = await postToStub(stub);
    expect(error.message).toBe('env_assist_bridge:bridge_auth_rejected');
    expectAuthRejectDetail({ status: 403, code: 'invalid_host' });
  });

  it('403 with a code-less JSON body (no `error` string): logs code as undefined, never the detail text', async () => {
    const stub = await startStub((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'user pressed "Don\'t Allow" in the system dialog' }));
    });
    stubs.push(stub);

    const error = await postToStub(stub);
    expect(error.message).toBe('env_assist_bridge:bridge_auth_rejected');
    expect((error as { bridgeError?: unknown }).bridgeError).toBeUndefined();
    expectAuthRejectDetail({ status: 403, code: undefined });
  });
});
