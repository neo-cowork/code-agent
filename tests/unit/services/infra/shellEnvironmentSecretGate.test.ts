import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
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

// Unique fake secret: planted in process.env AND in the mocked shell output.
// Must never appear in any file under the temp data dir.
const GATE_SECRET_KEY = 'XIAOMI_GATE_API_KEY';
const GATE_SECRET_VALUE = 'fake-gate-secret-9f3a1c77e2d4b5';

interface DirEntry {
  path: string;
  content: string;
}

function readAllFilesRecursively(root: string): DirEntry[] {
  const files: DirEntry[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      try {
        files.push({ path: entryPath, content: readFileSync(entryPath, 'utf8') });
      } catch {
        // Non-utf8 files: fail loudly — a secret could hide in raw bytes.
        files.push({ path: entryPath, content: '<unreadable>' });
      }
    }
  };
  walk(root);
  return files;
}

function expectNoSecretOnDisk(dataDir: string): void {
  const files = readAllFilesRecursively(dataDir);
  const hits = files.filter((file) => file.content.includes(GATE_SECRET_VALUE));
  expect(hits.map((hit) => hit.path)).toEqual([]);
  // Also: no file may carry the secret key name with a value assignment.
  const keyHits = files.filter((file) => file.content.includes(GATE_SECRET_KEY));
  expect(keyHits.map((hit) => hit.path)).toEqual([]);
}

function loadModule() {
  vi.resetModules();
  return import('../../../../src/host/services/infra/shellEnvironment');
}

describe('shellEnvironment secret gate (recursive on-disk grep)', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    execFileMock.mockReset();
    process.env = { ...originalEnv };
    tempDataDir = mkdtempSync(join(tmpdir(), 'shell-environment-gate-'));
    process.env.CODE_AGENT_DATA_DIR = tempDataDir;
    // Plant the fake secret in process.env: any code path that serializes
    // process.env (not just the captured shell output) must be caught too.
    process.env[GATE_SECRET_KEY] = GATE_SECRET_VALUE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('first-run capture: no file under the data dir contains the planted secret', async () => {
    process.env.CODE_AGENT_WEB_MODE = 'true';
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin:/bin';
    execSyncMock.mockReturnValue([
      'PATH=/opt/homebrew/bin:/usr/bin:/bin',
      'HOME=/Users/test',
      `${GATE_SECRET_KEY}=${GATE_SECRET_VALUE}`,
      '',
    ].join('\n'));

    const { loadShellEnvironment, getShellEnvironmentValue } = await loadModule();
    loadShellEnvironment();

    expect(execSyncMock).toHaveBeenCalledOnce();
    // The secret WAS captured in memory (that is by design)…
    expect(getShellEnvironmentValue(GATE_SECRET_KEY)).toBe(GATE_SECRET_VALUE);
    // …but nothing on disk may hold it.
    expectNoSecretOnDisk(tempDataDir);
    // Sanity: the cache file itself exists and the gate would fail on it
    // if it contained the secret (guards against a vacuous walk).
    const cacheFile = join(tempDataDir, 'cache', 'shell-environment.json');
    expect(statSync(cacheFile).mode & 0o777).toBe(0o600);
    expect(readAllFilesRecursively(tempDataDir).length).toBeGreaterThan(0);
  });

  it('cache-hit + background refresh: no file under the data dir contains the planted secret', async () => {
    process.env.CODE_AGENT_WEB_MODE = 'true';
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin:/bin';
    mkdirSync(join(tempDataDir, 'cache'), { recursive: true });
    writeFileSync(join(tempDataDir, 'cache', 'shell-environment.json'), JSON.stringify({
      schemaVersion: 2,
      platform: process.platform,
      shell: '/bin/zsh',
      capturedAt: '2026-11-21T00:00:00.000Z',
      environment: { PATH: '/cached/bin:/usr/bin' },
    }));
    let refreshCallback: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      refreshCallback = callback;
      return {};
    });

    const shellEnvironment = await loadModule();
    shellEnvironment.loadShellEnvironment();
    expect(execSyncMock).not.toHaveBeenCalled();

    refreshCallback?.(null, [
      'PATH=/fresh/bin:/usr/bin',
      `${GATE_SECRET_KEY}=${GATE_SECRET_VALUE}`,
      '',
    ].join('\n'), '');

    // The refresh applied the secret in memory…
    expect(shellEnvironment.getShellEnvironmentValue(GATE_SECRET_KEY)).toBe(GATE_SECRET_VALUE);
    // …but the refreshed cache file and everything else stay clean.
    expectNoSecretOnDisk(tempDataDir);
  });

  it('cache hit + synchronous re-capture on first read: no file under the data dir contains the planted secret', async () => {
    process.env.CODE_AGENT_WEB_MODE = 'true';
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin:/bin';
    mkdirSync(join(tempDataDir, 'cache'), { recursive: true });
    writeFileSync(join(tempDataDir, 'cache', 'shell-environment.json'), JSON.stringify({
      schemaVersion: 2,
      platform: process.platform,
      shell: '/bin/zsh',
      capturedAt: '2026-11-21T00:00:00.000Z',
      environment: { PATH: '/cached/bin:/usr/bin' },
    }));
    // Background refresh stays in flight (callback captured, never invoked):
    // the first read falls back to the synchronous re-capture.
    execFileMock.mockImplementation((_file, _args, _options, callback) => callback);
    execSyncMock.mockReturnValue([
      'PATH=/fresh/bin:/usr/bin',
      `${GATE_SECRET_KEY}=${GATE_SECRET_VALUE}`,
      '',
    ].join('\n'));

    const shellEnvironment = await loadModule();
    shellEnvironment.loadShellEnvironment();
    expect(execSyncMock).not.toHaveBeenCalled();

    // First read triggers the synchronous re-capture: the secret is in
    // memory (Claude auth inheritance)…
    expect(shellEnvironment.getShellEnvironmentValue(GATE_SECRET_KEY)).toBe(GATE_SECRET_VALUE);
    expect(execSyncMock).toHaveBeenCalledOnce();
    // …but the re-captured cache file and everything else stay clean.
    expectNoSecretOnDisk(tempDataDir);
  });
});
