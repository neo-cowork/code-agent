// 开启完全访问的 admin 门：区分「确认非管理员」「账号资料没取到（可重试）」，重校验后可恢复。
// 走真实 agent.ipc handler + 真实 adminGuard，只替身 auth 服务（形状同 AuthService 的公开面）。
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

const tmpDataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'full-access-gate-'));
process.env.CODE_AGENT_DATA_DIR = tmpDataDir;
afterAll(() => {
  delete process.env.CODE_AGENT_DATA_DIR;
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

const env = vi.hoisted(() => ({
  warns: [] as string[],
  user: null as { id: string; email: string; isAdmin?: boolean } | null,
  trust: 'none' as 'none' | 'cached' | 'verified',
  revalidateResults: [] as Array<'verified' | 'deferred' | 'verified-non-admin'>,
  revalidateCalls: 0,
}));

vi.mock('../../../src/host/services/infra/logger', () => {
  const log = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: (...args: unknown[]) => { env.warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); },
  };
  return { createLogger: vi.fn(() => log), logger: log, LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } };
});
vi.mock('../../../src/host/platform', () => ({
  app: { getVersion: () => '0.0.0-test' },
  AppWindow: { getFocusedWindow: () => null },
  broadcastToRenderer: vi.fn(),
}));
vi.mock('../../../src/host/services/auth', () => ({
  getAuthService: () => ({
    getCurrentUser: () => env.user,
    hasVerifiedSession: () => env.user !== null && env.trust === 'verified',
    getSessionTrustState: () => env.trust,
    revalidateSession: async () => {
      env.revalidateCalls += 1;
      const outcome = env.revalidateResults.shift() ?? 'deferred';
      if (outcome === 'verified' || outcome === 'verified-non-admin') env.trust = 'verified';
      if (outcome === 'verified-non-admin' && env.user) env.user = { ...env.user, isAdmin: false };
      return outcome === 'deferred' ? 'deferred' : 'verified';
    },
  }),
}));

import { resetPermissionModeManager, getPermissionModeManager } from '../../../src/host/permissions/modes';
import { registerAgentHandlers } from '../../../src/host/ipc/agent.ipc';

type DomainHandler = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;

describe('setSessionPermissionMode → bypassPermissions 的 admin 门', () => {
  let handler: DomainHandler;

  beforeEach(() => {
    resetPermissionModeManager();
    env.warns.length = 0;
    env.user = null;
    env.trust = 'none';
    env.revalidateResults = [];
    env.revalidateCalls = 0;
    const handlers = new Map<string, unknown>();
    registerAgentHandlers({ handle: (c: string, fn: unknown) => handlers.set(c, fn), on: vi.fn(), removeHandler: vi.fn() } as never, () => null);
    handler = handlers.get(IPC_DOMAINS.AGENT) as DomainHandler;
  });

  const enable = () => handler(null, {
    action: 'setSessionPermissionMode',
    payload: { sessionId: 's1', mode: 'bypassPermissions', approved: true },
  } as IPCRequest);

  it('缓存管理员 + 首次重校验超时 → ADMIN_VERIFICATION_PENDING；再次重校验成功 → 档位切换（无需重启）', async () => {
    env.user = { id: 'u1', email: 'a@b.c', isAdmin: true };
    env.trust = 'cached';
    env.revalidateResults = ['deferred', 'verified'];

    const first = await enable();
    expect(first.success).toBe(false);
    expect((first.error as { code: string }).code).toBe('ADMIN_VERIFICATION_PENDING');
    expect(getPermissionModeManager().getModeForSession('s1')).toBe('default');
    expect(env.warns.some((w) => w.includes('pending') && w.includes('"revalidate":"deferred"') && w.includes('"hasCachedAdminClaim":true'))).toBe(true);

    const second = await enable();
    expect(second.success).toBe(true);
    expect((second.data as { mode: string }).mode).toBe('bypassPermissions');
    expect(env.revalidateCalls).toBe(2);
  });

  it('已验证的非管理员 → FORBIDDEN，不触发重校验，日志标明原因', async () => {
    env.user = { id: 'u2', email: 'n@b.c', isAdmin: false };
    env.trust = 'verified';
    const res = await enable();
    expect(res.success).toBe(false);
    expect((res.error as { code: string }).code).toBe('FORBIDDEN');
    expect(env.revalidateCalls).toBe(0);
    expect(env.warns.some((w) => w.includes('not an admin') && w.includes('"trust":"verified"'))).toBe(true);
  });

  it('未登录 → FORBIDDEN 且不重校验', async () => {
    const res = await enable();
    expect((res.error as { code: string }).code).toBe('FORBIDDEN');
    expect(env.revalidateCalls).toBe(0);
  });

  it('重校验后确认不是管理员 → FORBIDDEN（日志区分 after revalidation）', async () => {
    env.user = { id: 'u3', email: 'c@b.c', isAdmin: true };
    env.trust = 'cached';
    env.revalidateResults = ['verified-non-admin'];
    const res = await enable();
    expect((res.error as { code: string }).code).toBe('FORBIDDEN');
    expect(env.warns.some((w) => w.includes('after revalidation'))).toBe(true);
  });
});
