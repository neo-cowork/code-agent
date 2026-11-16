// 原生桥非 2xx 时把路由自己的机器码（calendar_not_authorized / event_not_found）带给宿主，日历连接器据此分 not_authorized / not_found。
// Evidence class: hermetic-protocol（本机 http 桩，真实 fetch 客户端）。
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bridgeErrorCode, resolveShellBridgeClientFromEnv } from '../../../../../src/host/permissions/envAssist/shellBridge/client';

let server: http.Server;
let url = '';
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const [status, body] = req.url === '/v1/read/calendars' ? [403, { error: 'calendar_not_authorized', status: 2 }]
      : req.url === '/v1/read/calendar-event' ? [404, { error: 'event_not_found' }]
        : [500, 'not json'];
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

it('carries the route machine code on the thrown error, never the native detail; keeps the old reason text', async () => {
  const client = resolveShellBridgeClientFromEnv({ CODE_AGENT_ENV_ASSIST_BRIDGE_URL: url, CODE_AGENT_ENV_ASSIST_BRIDGE_TOKEN: 't' }, 'darwin')!;
  const fail = (path: string) => client.post(path).then(() => null, (e: unknown) => e);
  const forbidden = await fail('/v1/read/calendars');
  expect((forbidden as Error).message).toBe('env_assist_bridge:bridge_auth_rejected');
  expect(bridgeErrorCode(forbidden)).toBe('calendar_not_authorized');
  const missing = await fail('/v1/read/calendar-event');
  expect((missing as Error).message).toBe('env_assist_bridge:bridge_http_404');
  expect(bridgeErrorCode(missing)).toBe('event_not_found');
  const broken = await fail('/v1/other');
  expect((broken as Error).message).toBe('env_assist_bridge:bridge_http_500');
  expect(bridgeErrorCode(broken)).toBeUndefined();
});
