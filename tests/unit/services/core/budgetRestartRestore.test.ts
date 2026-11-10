import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../../src/shared/ipc';

// 重启后无人值守「已用额度」恢复：真实 sqlite（DatabaseService + usage_ledger/budget_period_state）
// + 真实 BudgetService。「重启」= 关库、同目录重开库、vi.resetModules 重新加载 budgetService 单例。
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const dbRef = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../../../../src/host/services/core/database/nativeLoader', () => ({ loadBetterSqlite3: () => Database }));
vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/services/infra/logger')>();
  return {
    ...actual,
    createLogger: (name: string) => (name === 'BudgetService' || name === 'SettingsIpc' ? log : actual.createLogger(name)),
  };
});
vi.mock('../../../../src/host/services/core/databaseService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/services/core/databaseService')>();
  return { ...actual, getDatabase: () => dbRef.current };
});
vi.mock('../../../../src/host/ipc/adminGuard', () => ({
  isCurrentUserAdmin: () => true,
  getAdminAccessIpcError: () => null,
  assertAdminAccess: vi.fn(),
}));
vi.mock('../../../../src/host/model/providerConnectionTest', () => ({ resolveConnectionTestModel: () => 'test-model' }));
vi.mock('../../../../src/host/services/providerIconAssets', () => ({
  saveProviderIconAsset: vi.fn(async () => ({})),
  resolveProviderIconAsset: vi.fn(async () => ''),
}));
vi.mock('../../../../src/shared/modelRuntime', () => ({ isRuntimeProviderConfigured: () => false }));
vi.mock('../../../../src/host/services/capabilities/hostCapabilityPorts', () => ({ refreshRegisteredVoiceInstructions: vi.fn() }));
vi.mock('../../../../src/host/services/core/secureStorage', () => ({
  getSecureStorage: () => ({ get: vi.fn(), set: vi.fn(), getStoredApiKeyProviders: () => [] }),
}));
vi.mock('../../../../src/host/platform', () => ({
  app: { getVersion: () => '9.9.9' },
  AppWindow: { getFocusedWindow: () => null },
}));

import { DatabaseService } from '../../../../src/host/services/core/databaseService';

type BudgetModule = typeof import('../../../../src/host/services/core/budgetService');

const HOUR = 3600_000;
const dirs: string[] = [];
let dir = '';
let current: DatabaseService | null = null;

async function openDb(): Promise<DatabaseService> {
  const db = new DatabaseService(dir);
  await db.initialize();
  current = db;
  dbRef.current = db;
  return db;
}

/** 模拟重启：关库 → 同目录重开 → 重新加载 budgetService（单例清零） */
async function restart(): Promise<BudgetModule> {
  current?.close();
  await openDb();
  vi.resetModules();
  return import('../../../../src/host/services/core/budgetService');
}

const usage = (over: Record<string, unknown> = {}) => ({
  inputTokens: 200_000,
  outputTokens: 50_000,
  model: 'deepseek-chat',
  provider: 'deepseek',
  timestamp: Date.now(),
  ...over,
});

async function statusVia(): Promise<IPCResponse> {
  const { registerSettingsHandlers } = await import('../../../../src/host/ipc/settings.ipc');
  const handlers = new Map<string, (e: unknown, r: IPCRequest) => Promise<IPCResponse>>();
  registerSettingsHandlers(
    { handle: (ch: string, fn: never) => handlers.set(ch, fn) } as never,
    () => ({} as never),
  );
  return handlers.get(IPC_DOMAINS.SETTINGS)!(null, { action: 'getBudgetStatus' } as IPCRequest);
}

beforeEach(async () => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-restore-'));
  dirs.push(dir);
  await openDb();
  vi.resetModules();
});

afterEach(() => {
  current?.close();
  current = null;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('unattended 预算跨重启恢复', () => {
  it('① 记 N 条 unattended 用量 → 重启后 getCurrentCost 与 IPC currentCost 前后一致', async () => {
    const first = await import('../../../../src/host/services/core/budgetService');
    first.initBudgetService({ unattended: { enabled: true, maxBudget: 100 } });
    const svc = first.getBudgetService('unattended');
    for (let i = 0; i < 4; i += 1) svc.recordUsage(usage({ inputTokens: 100_000 * (i + 1) }));
    const before = svc.getCurrentCost();
    expect(before).toBeGreaterThan(0);
    const beforeIpc = await statusVia();
    const beforeCost = (beforeIpc as { data: { scopes: { unattended: { currentCost: number } } } }).data.scopes.unattended.currentCost;
    expect(beforeCost).toBe(before);

    const second = await restart();
    second.initBudgetService({ unattended: { enabled: true, maxBudget: 100 } });
    expect(second.getBudgetService('unattended').getCurrentCost()).toBe(before);
    const afterIpc = await statusVia();
    expect(afterIpc.success).toBe(true);
    expect((afterIpc as { data: { scopes: { unattended: { currentCost: number } } } }).data.scopes.unattended.currentCost).toBe(before);
  });

  it('② 持久化周期已过 → 恢复为 0 且周期起点前移；未过 → 保留成本', async () => {
    const first = await import('../../../../src/host/services/core/budgetService');
    first.initBudgetService({ unattended: { enabled: true, maxBudget: 100, resetPeriodHours: 24 } });
    first.getBudgetService('unattended').recordUsage(usage());
    const cost = first.getBudgetService('unattended').getCurrentCost();

    // 周期未过（起点 23h 前）：成本保留，起点沿用
    const startKept = Date.now() - 23 * HOUR;
    current!.setBudgetPeriodStart('unattended', startKept, startKept);
    let mod = await restart();
    mod.initBudgetService({ unattended: { enabled: true, maxBudget: 100, resetPeriodHours: 24 } });
    expect(mod.getBudgetService('unattended').getCurrentCost()).toBe(cost);
    expect(current!.readBudgetScopeState('unattended', 0).periodStart).toBe(startKept);

    // 周期已过（起点 25h 前）：成本清零，起点前移到现在附近
    const startOld = Date.now() - 25 * HOUR;
    current!.setBudgetPeriodStart('unattended', startOld, startOld);
    mod = await restart();
    mod.initBudgetService({ unattended: { enabled: true, maxBudget: 100, resetPeriodHours: 24 } });
    expect(mod.getBudgetService('unattended').getCurrentCost()).toBe(0);
    const moved = current!.readBudgetScopeState('unattended', 0).periodStart!;
    expect(moved).toBeGreaterThan(startOld + HOUR);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('persisted period elapsed'));
  });

  it('③ 前台与无人值守不混账；前台实例不恢复', async () => {
    const first = await import('../../../../src/host/services/core/budgetService');
    first.initBudgetService({ foreground: { enabled: true, maxBudget: 100 }, unattended: { enabled: true, maxBudget: 100 } });
    first.getBudgetService('foreground').recordUsage(usage({ inputTokens: 900_000 }));
    first.getBudgetService('unattended').recordUsage(usage({ inputTokens: 100_000 }));
    const unattendedCost = first.getBudgetService('unattended').getCurrentCost();
    const foregroundCost = first.getBudgetService('foreground').getCurrentCost();
    expect(unattendedCost).not.toBe(foregroundCost);

    const second = await restart();
    second.initBudgetService({ foreground: { enabled: true, maxBudget: 100 }, unattended: { enabled: true, maxBudget: 100 } });
    expect(second.getBudgetService('unattended').getCurrentCost()).toBe(unattendedCost);
    expect(second.getBudgetService('foreground').getCurrentCost()).toBe(0);
    const rows = current!.getDb()!.prepare('SELECT scope, COUNT(*) AS c FROM usage_ledger GROUP BY scope ORDER BY scope').all();
    expect(rows).toEqual([{ scope: 'foreground', c: 1 }, { scope: 'unattended', c: 1 }]);
  });

  it('④ 带 service_tier 的行恢复成本 = 实时成本（档位列有效）', async () => {
    const first = await import('../../../../src/host/services/core/budgetService');
    first.initBudgetService({ unattended: { enabled: true, maxBudget: 100 } });
    const svc = first.getBudgetService('unattended');
    svc.recordUsage(usage({ model: 'gpt-5', provider: 'openai', serviceTier: 'flex' }));
    svc.recordUsage(usage({ model: 'gpt-5', provider: 'openai' }));
    const live = svc.getCurrentCost();
    const noTier = first.getBudgetService('foreground');
    noTier.recordUsage(usage({ model: 'gpt-5', provider: 'openai' }));
    // flex 档折价：两条同 token 的行成本不等于 2 倍标准价
    expect(live).toBeLessThan(noTier.getCurrentCost() * 2);

    const second = await restart();
    second.initBudgetService({ unattended: { enabled: true, maxBudget: 100 } });
    expect(second.getBudgetService('unattended').getCurrentCost()).toBe(live);
  });
});

describe('⑤ 读取失败可见', () => {
  it('db 未就绪 → IPC reject + 日志 not_ready；db 正常且历史为空 → 不 reject', async () => {
    const mod = await import('../../../../src/host/services/core/budgetService');
    const ok = await statusVia();
    expect(ok.success).toBe(true);

    current!.close();
    dbRef.current = new DatabaseService(dir); // 未 initialize = 未就绪
    vi.resetModules();
    log.warn.mockClear();
    const res = await (async () => {
      await import('../../../../src/host/services/core/budgetService');
      return statusVia();
    })();
    expect(mod).toBeDefined();
    expect(res.success).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('unavailable (not_ready)'), expect.anything());
  });

  it('读取抛错 → IPC reject + 日志 read_failed（与 not_ready 可区分）', async () => {
    current!.getDb()!.exec('DROP TABLE budget_period_state');
    const res = await statusVia();
    expect(res.success).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('unavailable (read_failed)'), expect.anything());
  });
});
