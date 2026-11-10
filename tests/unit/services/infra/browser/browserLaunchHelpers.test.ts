import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { launchSystemChromeCdpBrowser } from '../../../../../src/host/services/infra/browser/browserLaunchHelpers';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  existsSync: vi.fn(),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.resetAllMocks();
});

describe('system Chrome launch keychain args', () => {
  it.each([
    { temporaryProfile: true, keychain: 'none', mock: true, reason: 'ephemeral-profile' },
    { temporaryProfile: true, keychain: 'login.keychain-db', mock: true, reason: 'ephemeral-profile' },
    { temporaryProfile: false, keychain: 'login.keychain-db', mock: false, reason: 'persistent-keychain-ok' },
    { temporaryProfile: false, keychain: 'login.keychain', mock: false, reason: 'persistent-keychain-ok' },
    { temporaryProfile: false, keychain: 'none', mock: true, reason: 'persistent-keychain-missing' },
  ])('temporary=$temporaryProfile keychain=$keychain', async ({ temporaryProfile, keychain, mock, reason }) => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.mocked(fs.existsSync).mockImplementation((file) => String(file).endsWith(`/Library/Keychains/${keychain}`));
    const child = Object.assign(new EventEmitter(), {
      exitCode: 1, signalCode: null, stderr: new EventEmitter(),
    }) as unknown as ChildProcess;
    vi.mocked(spawn).mockReturnValue(child);
    const log = vi.fn();
    const onProcessStart = vi.fn();

    await expect(launchSystemChromeCdpBrowser({
      resolution: {
        requestedProvider: 'system-chrome-cdp', provider: 'system-chrome-cdp',
        systemExecutable: '/test/Chrome', missingExecutable: false,
        recommendedAction: null, providerFallbackReason: null,
      },
      profileDir: '/tmp/test-browser-profile', temporaryProfile,
      mode: 'headless', viewport: { width: 900, height: 700 },
      proxy: { mode: 'direct', server: null, bypass: [], source: 'default' },
      logger: { log }, onProcessStart, onProcessExit: vi.fn(),
    })).rejects.toThrow('System Chrome exited before CDP became ready');

    expect(onProcessStart).toHaveBeenCalledWith(child);
    expect(spawn).toHaveBeenCalledTimes(1);
    const args = vi.mocked(spawn).mock.calls[0][1];
    if (mock) expect(args).toContain('--use-mock-keychain');
    else expect(args).not.toContain('--use-mock-keychain');
    expect(log).toHaveBeenCalledWith('INFO', `System Chrome keychain: profile=${temporaryProfile ? 'isolated' : 'persistent'} temporary=${temporaryProfile ? 'yes' : 'no'} --use-mock-keychain=${mock ? 'yes' : 'no'} reason=${reason}`);
  });
});
