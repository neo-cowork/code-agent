import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execSync: execSyncMock,
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const originalEnv = { ...process.env };
let tempDataDir: string;

function writeCache(input: {
  schemaVersion?: number;
  shell?: string;
  environment?: Record<string, string>;
} = {}): string {
  const cachePath = join(tempDataDir, 'cache', 'shell-environment.json');
  mkdirSync(join(tempDataDir, 'cache'), { recursive: true });
  // Default schemaVersion must match SHELL_ENV_CACHE_SCHEMA_VERSION in
  // shellEnvironment.ts (2 since the cache started filtering secrets).
  writeFileSync(cachePath, JSON.stringify({
    schemaVersion: input.schemaVersion ?? 2,
    platform: process.platform,
    shell: input.shell ?? '/bin/zsh',
    capturedAt: '2026-07-14T00:00:00.000Z',
    environment: input.environment ?? { PATH: '/cached/bin:/usr/bin' },
  }));
  return cachePath;
}

async function loadModule() {
  vi.resetModules();
  return import('../../../../src/host/services/infra/shellEnvironment');
}

describe('shellEnvironment', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    execFileMock.mockReset();
    process.env = { ...originalEnv };
    tempDataDir = mkdtempSync(join(tmpdir(), 'shell-environment-test-'));
    process.env.CODE_AGENT_DATA_DIR = tempDataDir;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('adds common macOS CLI fallback paths when process PATH is degraded', async () => {
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    delete process.env.CODE_AGENT_CLI_MODE;
    delete process.env.CODE_AGENT_WEB_MODE;

    const { getShellPathDiagnostics } = await loadModule();
    const diagnostics = getShellPathDiagnostics();

    expect(diagnostics.degraded).toBe(true);
    expect(diagnostics.fallbackApplied).toBe(true);
    expect(diagnostics.path.split(':')).toEqual([
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      '/Library/Apple/usr/bin',
    ]);
  });

  it('keeps an existing non-degraded PATH unchanged', async () => {
    process.env.PATH = '/custom/bin:/usr/bin:/bin';

    const { getShellPathDiagnostics } = await loadModule();
    const diagnostics = getShellPathDiagnostics();

    expect(diagnostics.degraded).toBe(false);
    expect(diagnostics.fallbackApplied).toBe(false);
    expect(diagnostics.path).toBe('/custom/bin:/usr/bin:/bin');
  });

  it('skips shell capture only in pure CLI mode', async () => {
    process.env.CODE_AGENT_CLI_MODE = 'true';
    delete process.env.CODE_AGENT_WEB_MODE;
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

    const { loadShellEnvironment } = await loadModule();
    loadShellEnvironment();

    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it('captures login shell PATH in web mode even when CLI mode is set for native modules', async () => {
    process.env.CODE_AGENT_CLI_MODE = 'true';
    process.env.CODE_AGENT_WEB_MODE = 'true';
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    execSyncMock.mockReturnValue('PATH=/opt/homebrew/bin:/usr/bin:/bin\nHOME=/Users/test\nSECRET_TOKEN=hidden\n');

    const { loadShellEnvironment, getShellEnvironmentValue, getShellPathDiagnostics } = await loadModule();
    loadShellEnvironment();
    const diagnostics = getShellPathDiagnostics();

    expect(execSyncMock).toHaveBeenCalledWith("/bin/zsh -i -l -c 'env'", expect.any(Object));
    expect(diagnostics.source).toBe('captured');
    expect(diagnostics.path).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    expect(diagnostics.degraded).toBe(false);
    // In-memory environment keeps the secret (Claude auth inheritance needs it).
    expect(getShellEnvironmentValue('SECRET_TOKEN')).toBe('hidden');
    expect(JSON.stringify(diagnostics)).not.toContain('SECRET_TOKEN');
    expect(JSON.stringify(diagnostics)).not.toContain('hidden');
    // The on-disk cache must NOT contain the secret — neither the key nor the value.
    const cachePath = join(tempDataDir, 'cache', 'shell-environment.json');
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).environment.SECRET_TOKEN).toBeUndefined();
    expect(readFileSync(cachePath, 'utf8')).not.toContain('hidden');
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
  });

  it('uses a valid cache immediately and refreshes it in the background', async () => {
    process.env.CODE_AGENT_CLI_MODE = 'true';
    process.env.CODE_AGENT_WEB_MODE = 'true';
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin:/bin';
    const cachePath = writeCache({
      environment: { PATH: '/cached/bin:/usr/bin', CACHE_ONLY: 'old' },
    });
    let refreshCallback: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      refreshCallback = callback;
      return {};
    });

    const { loadShellEnvironment, getShellEnvironmentValue, getShellPathDiagnostics } = await loadModule();
    loadShellEnvironment();

    expect(execSyncMock).not.toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledWith(
      '/bin/zsh',
      ['-i', '-l', '-c', 'env'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(getShellEnvironmentValue('CACHE_ONLY')).toBe('old');
    expect(getShellPathDiagnostics().path).toBe('/cached/bin:/usr/bin:/bin');

    refreshCallback?.(null, 'PATH=/fresh/bin:/usr/bin\nCACHE_ONLY=new\n', '');
    expect(getShellEnvironmentValue('CACHE_ONLY')).toBe('new');
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).environment.CACHE_ONLY).toBe('new');
  });

  it('invalidates an incompatible cache and preserves synchronous first-run capture', async () => {
    process.env.CODE_AGENT_WEB_MODE = 'true';
    process.env.SHELL = '/bin/zsh';
    writeCache({ schemaVersion: 0 });
    execSyncMock.mockReturnValue('PATH=/captured/bin:/usr/bin\nSOURCE=fresh-capture\n');

    const { loadShellEnvironment, getShellEnvironmentValue } = await loadModule();
    loadShellEnvironment();

    expect(execSyncMock).toHaveBeenCalledOnce();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(getShellEnvironmentValue('SOURCE')).toBe('fresh-capture');
  });

  it('keeps cached values when the background refresh fails', async () => {
    process.env.CODE_AGENT_WEB_MODE = 'true';
    process.env.SHELL = '/bin/zsh';
    writeCache({ environment: { PATH: '/cached/bin', KEEP_ME: 'yes' } });
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error('refresh failed'), '', '');
      return {};
    });

    const { loadShellEnvironment, getShellEnvironmentValue } = await loadModule();
    loadShellEnvironment();

    expect(execSyncMock).not.toHaveBeenCalled();
    expect(getShellEnvironmentValue('KEEP_ME')).toBe('yes');
  });

  it('uses fallback paths when shell capture fails and process PATH is degraded', async () => {
    process.env.CODE_AGENT_WEB_MODE = 'true';
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    execSyncMock.mockImplementation(() => {
      throw new Error('capture failed');
    });

    const { loadShellEnvironment, getShellPathDiagnostics } = await loadModule();
    loadShellEnvironment();
    const diagnostics = getShellPathDiagnostics();

    expect(diagnostics.source).toBe('process');
    expect(diagnostics.degraded).toBe(true);
    expect(diagnostics.fallbackApplied).toBe(true);
    expect(diagnostics.path).toContain('/opt/homebrew/bin');
    expect(diagnostics.path).toContain('/usr/local/bin');
  });

  it('writes a first-run cache without secret keys or credential-bearing values, keeping PATH and clean proxy', async () => {
    process.env.CODE_AGENT_WEB_MODE = 'true';
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin:/bin';
    const fakeSecrets: Record<string, string> = {
      XIAOMI_API_KEY: 'fake-xiaomi-value-a1',
      VOLC_ACCESSKEY: 'fake-volc-access-a2',
      VOLC_SECRETKEY: 'fake-volc-secret-a3',
      TAVILY_API_KEYS: 'fake-tavily-multi-a4',
      TENCENTCLOUD_SECRET_ID: 'fake-secret-id-a5',
    };
    execSyncMock.mockReturnValue([
      'PATH=/opt/homebrew/bin:/usr/bin:/bin',
      'HOME=/Users/test',
      'SHELL=/bin/zsh',
      'LANG=en_US.UTF-8',
      'HTTPS_PROXY=http://alice:corp-pw@proxy.internal:8080',
      'HTTP_PROXY=http://proxy.internal:3128',
      ...Object.entries(fakeSecrets).map(([key, value]) => `${key}=${value}`),
      '',
    ].join('\n'));

    const { loadShellEnvironment, getShellEnvironmentValue } = await loadModule();
    loadShellEnvironment();

    const cachePath = join(tempDataDir, 'cache', 'shell-environment.json');
    const rawCache = readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(rawCache).environment as Record<string, string>;

    // Raw cache text contains none of the fake secret VALUES…
    for (const value of Object.values(fakeSecrets)) {
      expect(rawCache).not.toContain(value);
    }
    // …nor the password embedded in the proxy URL.
    expect(rawCache).not.toContain('corp-pw');
    // …and none of the secret KEYS (substring match: SECRET_ID is gone too).
    for (const key of Object.keys(fakeSecrets)) {
      expect(parsed[key]).toBeUndefined();
      expect(rawCache).not.toContain(key);
    }
    // Proxy with userinfo is dropped, credential-free proxy survives.
    expect(parsed.HTTPS_PROXY).toBeUndefined();
    expect(parsed.HTTP_PROXY).toBe('http://proxy.internal:3128');
    // PATH and locale-style values survive.
    expect(parsed.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin');
    expect(parsed.LANG).toBe('en_US.UTF-8');
    // File mode stays 0600.
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
    // In-memory environment still exposes the secrets after a fresh capture.
    expect(getShellEnvironmentValue('XIAOMI_API_KEY')).toBe('fake-xiaomi-value-a1');
    expect(getShellEnvironmentValue('TAVILY_API_KEYS')).toBe('fake-tavily-multi-a4');
  });

  it('rejects a legacy plaintext cache (schemaVersion 1) and overwrites it with a filtered capture', async () => {
    process.env.CODE_AGENT_WEB_MODE = 'true';
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin:/bin';
    const cachePath = writeCache({
      schemaVersion: 1,
      environment: { PATH: '/cached/bin:/usr/bin', XIAOMI_API_KEY: 'fake-legacy-secret-b1' },
    });
    execSyncMock.mockReturnValue('PATH=/fresh/bin:/usr/bin\nHOME=/Users/test\n');

    const { loadShellEnvironment, getShellEnvironmentValue } = await loadModule();
    loadShellEnvironment();

    // Path proof: legacy cache rejected → synchronous capture branch ran.
    expect(execSyncMock).toHaveBeenCalledOnce();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(getShellEnvironmentValue('HOME')).toBe('/Users/test');

    // Observable proof: the file on disk afterwards has no fake value.
    const rawCache = readFileSync(cachePath, 'utf8');
    expect(rawCache).not.toContain('fake-legacy-secret-b1');
    expect(rawCache).not.toContain('XIAOMI_API_KEY');
    expect(JSON.parse(rawCache).schemaVersion).toBe(2);
    expect(JSON.parse(rawCache).environment.PATH).toBe('/fresh/bin:/usr/bin');
  });

  it('keeps secrets in memory but writes a filtered file when the background refresh applies', async () => {
    process.env.CODE_AGENT_WEB_MODE = 'true';
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin:/bin';
    const cachePath = writeCache({
      environment: { PATH: '/cached/bin:/usr/bin', HTTP_PROXY: 'http://proxy.internal:3128' },
    });
    let refreshCallback: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      refreshCallback = callback;
      return {};
    });

    const { loadShellEnvironment, getShellEnvironmentValue, getShellPathDiagnostics } = await loadModule();
    loadShellEnvironment();

    expect(getShellEnvironmentValue('ANTHROPIC_API_KEY')).toBeUndefined();
    refreshCallback?.(null, [
      'PATH=/fresh/bin:/usr/bin',
      'ANTHROPIC_API_KEY=fake-anthropic-refresh-c1',
      'HTTPS_PROXY=http://bob:refresh-pw@proxy.internal:8080',
      '',
    ].join('\n'), '');

    // In-memory: the refreshed secret is available (Claude auth inheritance).
    expect(getShellEnvironmentValue('ANTHROPIC_API_KEY')).toBe('fake-anthropic-refresh-c1');
    expect(getShellPathDiagnostics().path).toBe('/fresh/bin:/usr/bin:/bin');

    // On disk: the refreshed cache file is filtered too.
    const rawCache = readFileSync(cachePath, 'utf8');
    expect(rawCache).not.toContain('fake-anthropic-refresh-c1');
    expect(rawCache).not.toContain('ANTHROPIC_API_KEY');
    expect(rawCache).not.toContain('refresh-pw');
    const parsed = JSON.parse(rawCache).environment as Record<string, string>;
    // The refresh replaces the environment wholesale with the fresh capture.
    expect(parsed.PATH).toBe('/fresh/bin:/usr/bin');
    // Proxy with userinfo is dropped by the refresh path as well.
    expect(parsed.HTTPS_PROXY).toBeUndefined();
  });
});
