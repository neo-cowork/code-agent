import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keytarState = vi.hoisted(() => ({
  current: null as null | {
    setPassword: (service: string, account: string, password: string) => Promise<void>;
    getPassword: (service: string, account: string) => Promise<string | null>;
    deletePassword: (service: string, account: string) => Promise<boolean>;
  },
}));

const keytarMock = vi.hoisted(() => ({
  setPassword: vi.fn(async () => undefined),
  getPassword: vi.fn(async (_service: string, _account: string): Promise<string | null> => null),
  deletePassword: vi.fn(async () => true),
}));

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../../src/host/services/core/keytarAdapter', () => ({
  loadKeytar: () => keytarState.current,
}));
vi.mock('../../../../src/host/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  app: null,
}));
vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => loggerMock,
}));

describe('SecureStorage Keychain degrade trace reasons (FB 03)', () => {
  let dataDir: string;
  const originalDataDir = process.env.CODE_AGENT_DATA_DIR;
  const originalCliMode = process.env.CODE_AGENT_CLI_MODE;
  const originalWebMode = process.env.CODE_AGENT_WEB_MODE;
  const originalBundleId = process.env.CODE_AGENT_BUNDLE_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    keytarState.current = keytarMock;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-storage-keychain-trace-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    delete process.env.CODE_AGENT_CLI_MODE;
    delete process.env.CODE_AGENT_WEB_MODE;
    delete process.env.CODE_AGENT_BUNDLE_ID;
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    if (originalCliMode === undefined) delete process.env.CODE_AGENT_CLI_MODE;
    else process.env.CODE_AGENT_CLI_MODE = originalCliMode;
    if (originalWebMode === undefined) delete process.env.CODE_AGENT_WEB_MODE;
    else process.env.CODE_AGENT_WEB_MODE = originalWebMode;
    if (originalBundleId === undefined) delete process.env.CODE_AGENT_BUNDLE_ID;
    else process.env.CODE_AGENT_BUNDLE_ID = originalBundleId;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('keytar unavailable → warn reason keychain_module_unavailable once per process', async () => {
    keytarState.current = null;
    const { getSecureStorage } = await import('../../../../src/host/services/core/secureStorage');
    const storage = getSecureStorage();

    await expect(storage.getSessionFromKeychain({ forSessionRead: true })).resolves.toBeNull();
    await expect(storage.getSessionFromKeychain({ forSessionRead: true })).resolves.toBeNull();

    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith('Supabase session Keychain unavailable', {
      reason: 'keychain_module_unavailable',
    });
  });

  it('session read finding no entry → warn reason keychain_entry_missing once per process', async () => {
    keytarMock.getPassword.mockResolvedValue(null);
    const { getSecureStorage } = await import('../../../../src/host/services/core/secureStorage');
    const storage = getSecureStorage();

    // 非 session 读不告警
    await expect(storage.getSessionFromKeychain()).resolves.toBeNull();
    expect(loggerMock.warn).not.toHaveBeenCalled();

    // session 读告警，且多次读取只告警一次
    await expect(storage.getSessionFromKeychain({ forSessionRead: true })).resolves.toBeNull();
    await expect(storage.getSessionFromKeychain({ forSessionRead: true })).resolves.toBeNull();

    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Supabase session Keychain entry missing on read',
      { reason: 'keychain_entry_missing' },
    );
  });

  it('entry present on a session read → no missing-entry warn', async () => {
    keytarMock.getPassword.mockResolvedValue('session-json');
    const { getSecureStorage } = await import('../../../../src/host/services/core/secureStorage');
    const storage = getSecureStorage();

    await expect(storage.getSessionFromKeychain({ forSessionRead: true })).resolves.toBe('session-json');
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('keytar read throwing → existing error path carries reason keychain_read_error', async () => {
    keytarMock.getPassword.mockRejectedValue(new Error('keychain locked'));
    const { getSecureStorage } = await import('../../../../src/host/services/core/secureStorage');
    const storage = getSecureStorage();

    await expect(storage.getSessionFromKeychain({ forSessionRead: true })).resolves.toBeNull();

    expect(loggerMock.error).toHaveBeenCalledWith('Failed to get session from Keychain:', {
      reason: 'keychain_read_error',
      error: expect.any(Error),
    });
    // 读取失败不走 once-per-process warn 通道
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('hasAnyPastLoginTrace sees historical session keys but not unrelated data', async () => {
    const { getSecureStorage } = await import('../../../../src/host/services/core/secureStorage');
    const storage = getSecureStorage();

    expect(storage.hasAnyPastLoginTrace()).toBe(false);

    storage.set('device.id', 'device-1');
    expect(storage.hasAnyPastLoginTrace()).toBe(false);

    storage.set('sb-projectref-auth-token' as never,'{"stub":true}');
    expect(storage.hasAnyPastLoginTrace()).toBe(true);

    storage.delete('sb-projectref-auth-token' as never);
    storage.set('auth.saved_email', 'someone@example.com');
    expect(storage.hasAnyPastLoginTrace()).toBe(true);
  });
});
