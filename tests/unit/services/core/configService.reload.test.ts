import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { readFileSync, type FSWatcher } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const loggerMock = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const secureStorageMock = {
  getSettingsFromKeychain: vi.fn(async () => null),
  saveSettingsToKeychain: vi.fn(async () => undefined),
  getApiKey: vi.fn(() => undefined),
  setApiKey: vi.fn(),
  getStoredApiKeyProviders: vi.fn(() => []),
};

// 提到顶层以便断言 reload 重跑了注入全局状态的 apply 函数
const loadUserRules = vi.fn();
const watchers: FSWatcher[] = [];
const setProviderConcurrencyOverrides = vi.fn();
const setProviderProxyOverrides = vi.fn();

async function loadConfigServiceForDataDir(dataDir: string) {
  vi.resetModules();
  vi.doMock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return { ...actual, watch: (...args: Parameters<typeof actual.watch>) => {
      const watcher = actual.watch(...args);
      vi.spyOn(watcher, 'unref');
      watchers.push(watcher);
      return watcher;
    } };
  });
  secureStorageMock.getSettingsFromKeychain.mockClear();
  secureStorageMock.saveSettingsToKeychain.mockClear();
  loadUserRules.mockClear();
  setProviderConcurrencyOverrides.mockClear();
  setProviderProxyOverrides.mockClear();
  loggerMock.warn.mockClear();
  loggerMock.info.mockClear();

  vi.doMock('../../../../src/host/platform', () => ({
    app: {
      isPackaged: false,
      getPath: (name: string) => {
        if (name === 'userData' || name === 'home') return dataDir;
        return dataDir;
      },
    },
  }));
  vi.doMock('../../../../src/host/services/core/secureStorage', () => ({
    getSecureStorage: () => secureStorageMock,
  }));
  vi.doMock('../../../../src/host/services/infra/logger', () => ({
    createLogger: () => loggerMock,
  }));
  vi.doMock('../../../../src/host/permissions/policyEngine', () => ({
    getPolicyEngine: () => ({ loadUserRules }),
  }));
  vi.doMock('../../../../src/host/model/concurrencyLimiter', () => ({
    setProviderConcurrencyOverrides,
  }));
  vi.doMock('../../../../src/host/model/providers/shared', () => ({
    setProviderProxyOverrides,
  }));

  return import('../../../../src/host/services/core/configService');
}

async function createDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'code-agent-config-reload-'));
}

afterEach(() => {
  vi.doUnmock('../../../../src/host/platform');
  vi.doUnmock('../../../../src/host/services/core/secureStorage');
  vi.doUnmock('../../../../src/host/services/infra/logger');
  vi.doUnmock('../../../../src/host/permissions/policyEngine');
  vi.doUnmock('../../../../src/host/model/concurrencyLimiter');
  vi.doUnmock('../../../../src/host/model/providers/shared');
  for (const watcher of watchers.splice(0)) watcher.close();
  vi.doUnmock('fs');
  vi.resetModules();
});

describe('ConfigService.reloadFromDisk', () => {
  it('picks up external edits into memory and re-runs apply hooks', async () => {
    const dataDir = await createDataDir();
    const configPath = join(dataDir, 'config.json');
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    await service.initialize();

    expect(service.getSettings().models.default).not.toBe('openai');
    // 模拟外部直接编辑 config.json
    loadUserRules.mockClear();
    setProviderConcurrencyOverrides.mockClear();
    setProviderProxyOverrides.mockClear();
    await writeFile(configPath, JSON.stringify({ models: { default: 'openai' } }));

    const ok = await service.reloadFromDisk();

    expect(ok).toBe(true);
    expect(service.getSettings().models.default).toBe('openai');
    // 三个注入全局状态的 apply 函数都被重新执行
    expect(loadUserRules).toHaveBeenCalledTimes(1);
    expect(setProviderConcurrencyOverrides).toHaveBeenCalledTimes(1);
    expect(setProviderProxyOverrides).toHaveBeenCalledTimes(1);
  });

  it('does not write back to disk (no save/sanitize side effects)', async () => {
    const dataDir = await createDataDir();
    const configPath = join(dataDir, 'config.json');
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    await service.initialize();

    // 写一份最小配置,reload 不应把完整默认值回写磁盘
    const minimal = { models: { default: 'openai' } };
    await writeFile(configPath, JSON.stringify(minimal));
    const ok = await service.reloadFromDisk();

    expect(ok).toBe(true);
    const onDisk = JSON.parse(await readFile(configPath, 'utf-8'));
    expect(onDisk).toEqual(minimal);
  });

  it('returns false and warns on invalid JSON and non-object files without changing memory', async () => {
    const dataDir = await createDataDir();
    const configPath = join(dataDir, 'config.json');
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    await service.initialize();

    const before = service.getSettings().models.default;
    await writeFile(configPath, '{ this is not valid json');

    expect(await service.reloadFromDisk()).toBe(false);
    expect(service.getSettings().models.default).toBe(before);
    expect(loggerMock.warn).toHaveBeenCalledWith('Config reload skipped: file is not a JSON object');

    await writeFile(configPath, '[]');

    expect(await service.reloadFromDisk()).toBe(false);
    expect(service.getSettings().models.default).toBe(before);
    expect(loggerMock.warn).toHaveBeenCalledTimes(2);
  });
});

describe('ConfigService config.json watcher', () => {
  it('warns without throwing when the config directory is missing', async () => {
    const dataDir = join(await createDataDir(), 'missing');
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    expect(() => service.startWatchingConfigFile()).not.toThrow();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Failed to watch config file', expect.objectContaining({ error: expect.any(String) }),
    );
    service.stopWatchingConfigFile();
  });

  it('watches a missing config file without retaining the process and closes on stop', async () => {
    const dataDir = await createDataDir();
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    service.startWatchingConfigFile();
    const watcher = watchers.at(-1)!;
    const closed = new Promise<void>((resolve) => watcher.once('close', resolve));
    expect(watcher.unref).toHaveBeenCalledOnce();
    service.stopWatchingConfigFile();
    await closed;
  });

  it('hot-reloads hand-edited deny rules without a later settings save writing them back', async () => {
    const webServerSource = readFileSync(join(process.cwd(), 'src/web/webServer.ts'), 'utf8');
    expect(webServerSource).toContain('configService.startWatchingConfigFile()');

    const dataDir = await createDataDir();
    const configPath = join(dataDir, 'config.json');
    const { ConfigService } = await loadConfigServiceForDataDir(dataDir);
    const service = new ConfigService();
    await service.initialize();
    await service.updateSettings({
      permissions: { ...service.getSettings().permissions, deny: [] },
    });
    service.startWatchingConfigFile();

    try {
      const handEdited = JSON.parse(await readFile(configPath, 'utf8')) as {
        permissions?: { deny?: string[] };
      };
      handEdited.permissions = { ...handEdited.permissions, deny: ['Bash(ls *)'] };
      loadUserRules.mockClear();
      await writeFile(configPath, JSON.stringify(handEdited, null, 2));

      await vi.waitFor(() => {
        expect(loadUserRules).toHaveBeenCalledWith(
          expect.objectContaining({ deny: ['Bash(ls *)'] }),
          'external',
        );
      }, { timeout: 4000, interval: 50 });
      expect(service.getSettings().permissions.deny).toEqual(['Bash(ls *)']);

      await service.updateSettings({
        permissions: { ...service.getSettings().permissions, ask: ['Bash(pwd *)'] },
      });

      const onDisk = JSON.parse(await readFile(configPath, 'utf8')) as {
        permissions: { deny: string[]; ask: string[] };
      };
      expect(onDisk.permissions.deny).toEqual(['Bash(ls *)']);
      expect(onDisk.permissions.ask).toEqual(['Bash(pwd *)']);
      expect(loggerMock.info).toHaveBeenCalledWith('Config hot-reloaded from disk');

      const before = service.getSettings();
      loggerMock.warn.mockClear();
      for (const invalid of ['{ invalid json', '[]']) {
        await writeFile(configPath, invalid);
        await vi.waitFor(() => {
          expect(loggerMock.warn).toHaveBeenCalledWith('Config reload skipped: file is not a JSON object');
        }, { timeout: 4000, interval: 50 });
        expect(service.getSettings()).toEqual(before);
        loggerMock.warn.mockClear();
      }
    } finally {
      service.stopWatchingConfigFile();
    }
  });
});
