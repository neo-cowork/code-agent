/**
 * auth_user_blank:<ms> 故障开关：真编译产物 dist/web/dev-fault-inject.cjs 经
 * devFaultLoader → AuthService.getCurrentUser() 产线入口把登录态短时读空再自行恢复。
 * 非 Dev 数据目录与模块文件缺失两条路都必须退化为 no-op。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AuthUser } from '../../../src/shared/contract';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
}));
vi.mock('../../../src/host/services/infra/supabaseService', () => ({
  ensureSupabaseInitialized: () => { throw new Error('supabase unavailable in this test'); },
  getSupabase: () => null,
  isSupabaseInitialized: () => false,
}));
vi.mock('../../../src/host/services/cloudRun/cloudRunLedger', () => ({ bindCloudRunAccountSource: vi.fn() }));
const storage = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock('../../../src/host/services/core', () => ({
  getConfigService: () => { throw new Error('config service unavailable in this test'); },
  getSecureStorage: () => ({
    get: (key: string) => storage.values.get(key),
    set: (key: string, value: string) => { storage.values.set(key, value); },
    delete: (key: string) => { storage.values.delete(key); },
    hasAnyPastLoginTrace: () => false,
    hasStoredSupabaseSession: async () => false,
  }),
}));

import { getAuthService } from '../../../src/host/services/auth/authService';
import { devFaultOverrideCurrentUser } from '../../../src/host/services/infra/devFaultLoader';

const MODULE_PATH = path.join(process.cwd(), 'dist/web/dev-fault-inject.cjs');
let hadModule = false;
let tmp: string;
let devDir: string;
let prodDir: string;
const savedEnv = { ...process.env };

const USER: AuthUser = { id: 'u1', email: 'u1@example.test' };

function useFault(value: string | undefined, dataDir: string): void {
  if (value === undefined) delete process.env.NEO_DEV_FAULT;
  else process.env.NEO_DEV_FAULT = value;
  process.env.CODE_AGENT_DATA_DIR = dataDir;
}

function seedUser(user: AuthUser | null): void {
  (getAuthService() as unknown as { currentUser: AuthUser | null }).currentUser = user;
}

function injectedLines(): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('dev_fault_inject'));
}

beforeAll(() => {
  hadModule = fs.existsSync(MODULE_PATH);
  // 每次现编，避免读到上一次构建留下的旧产物
  esbuild.buildSync({
    entryPoints: ['src/web/devFaultInject.ts'], outfile: MODULE_PATH,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'error',
  });
});

afterAll(() => {
  if (!hadModule) fs.rmSync(MODULE_PATH, { force: true });
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-user-blank-'));
  devDir = path.join(tmp, '.code-agent-dev2');
  prodDir = path.join(tmp, '.code-agent');
  fs.mkdirSync(devDir);
  fs.mkdirSync(prodDir);
  warn.mockClear();
  storage.values.clear();
  seedUser(USER);
});

afterEach(() => {
  process.env = { ...savedEnv };
  seedUser(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('auth_user_blank:<ms>', () => {
  it('Dev 槽：start 文件出现才开窗，窗口内读空、到点恢复，开关窗各留一行日志', () => {
    vi.useFakeTimers();
    useFault('auth_user_blank:1000', devDir);
    const auth = getAuthService();
    // env 布防但未触发：.start 文件出现前读到的仍是真实用户，也不该有日志
    expect(auth.getCurrentUser()).toEqual(USER);
    const startFile = path.join(devDir, 'dev-fault/auth_user_blank.start');
    fs.mkdirSync(path.dirname(startFile), { recursive: true });
    fs.writeFileSync(startFile, '1');
    expect(auth.getCurrentUser()).toBeNull();
    expect(fs.existsSync(startFile)).toBe(false); // .start 文件被消费（删除）
    expect(injectedLines()).toEqual(['dev_fault_inject auth_user_blank blank 1000ms']);
    vi.advanceTimersByTime(999);
    expect(auth.getCurrentUser()).toBeNull();
    vi.advanceTimersByTime(2);
    expect(auth.getCurrentUser()).toEqual(USER);
    expect(injectedLines()).toEqual([
      'dev_fault_inject auth_user_blank blank 1000ms',
      'dev_fault_inject auth_user_blank recovered',
    ]);
    // 恢复后不再回空、不再加日志；start 文件已消费也不会二次开窗
    expect(auth.getCurrentUser()).toEqual(USER);
    expect(injectedLines()).toHaveLength(2);
  });

  it('非 Dev 数据目录：同样的 env + start 文件永不读空，文件原样保留', () => {
    useFault('auth_user_blank:1000', prodDir);
    const startFile = path.join(prodDir, 'dev-fault/auth_user_blank.start');
    fs.mkdirSync(path.dirname(startFile), { recursive: true });
    fs.writeFileSync(startFile, '1');
    expect(getAuthService().getCurrentUser()).toEqual(USER);
    expect(getAuthService().getCurrentUser()).toEqual(USER);
    expect(fs.existsSync(startFile)).toBe(true);
    expect(injectedLines()).toHaveLength(0);
  });

  it('模块文件缺失：Dev 槽 + env + start 文件也全部退化为原样放行', () => {
    const aside = `${MODULE_PATH}.aside`;
    fs.renameSync(MODULE_PATH, aside);
    try {
      useFault('auth_user_blank:1000', devDir);
      const startFile = path.join(devDir, 'dev-fault/auth_user_blank.start');
      fs.mkdirSync(path.dirname(startFile), { recursive: true });
      fs.writeFileSync(startFile, '1');
      expect(getAuthService().getCurrentUser()).toEqual(USER);
      expect(devFaultOverrideCurrentUser(USER)).toEqual(USER);
      expect(devFaultOverrideCurrentUser(null)).toBeNull();
      expect(fs.existsSync(startFile)).toBe(true);
    } finally {
      fs.renameSync(aside, MODULE_PATH);
    }
    expect(injectedLines()).toHaveLength(0);
  });
});
