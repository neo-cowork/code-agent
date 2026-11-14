import childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';
import type { loadVadRuntime } from '../../../src/host/services/desktop/audioVadRuntime';

const leaves = vi.hoisted(() => ({
  loadVadRuntime: vi.fn<typeof loadVadRuntime>(),
  getRuntimeAssetsStatus: vi.fn(async () => ({ assets: [{ id: 'onnxruntime-vad', state: 'ready' }] })),
  prepareRuntimeAssetOnDemand: vi.fn(),
  userConfigDir: '/tmp/audio-vad-chain-config',
}));

vi.mock('../../../src/host/services/desktop/audioVadRuntime', () => ({
  loadVadRuntime: leaves.loadVadRuntime,
  isOrtTensor: vi.fn(() => false),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/host/config/configPaths', () => ({ getUserConfigDir: () => leaves.userConfigDir }));
vi.mock('../../../src/host/runtime/runtimeAssetStatus', () => ({ getRuntimeAssetsStatus: leaves.getRuntimeAssetsStatus }));
vi.mock('../../../src/host/services/cloud/updateService', () => ({ prepareRuntimeAssetOnDemand: leaves.prepareRuntimeAssetOnDemand }));
vi.mock('../../../src/host/services/desktop/nativeDesktopService', () => ({
  getNativeDesktopService: () => ({ getStatus: () => ({ sqliteDbPath: null, running: false }) }),
}));
// Unrelated entry-point leaves: registration must not start desktop/browser work.
vi.mock('../../../src/host/services/desktop/desktopVisionAnalyzer', () => ({ startDesktopVisionAnalyzer: vi.fn() }));
vi.mock('../../../src/host/services/desktop/computerSurface', () => ({ getComputerSurface: vi.fn() }));
vi.mock('../../../src/host/services/infra/browserService', () => ({ browserService: {} }));
vi.mock('../../../src/host/services/infra/browserRelayService', () => ({ browserRelayService: {} }));
vi.mock('../../../src/host/services/infra/browser/managedBrowserCookieImport', () => ({
  clearManagedBrowserCookiesViaService: vi.fn(), importBrowserProfileCookiesViaService: vi.fn(), listImportableBrowserProfiles: vi.fn(),
}));
vi.mock('../../../src/host/services/surfaceExecution/BrowserProfileImportApprovalService', () => ({ getBrowserProfileImportApprovalService: vi.fn() }));
vi.mock('../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter', () => ({ getManagedBrowserProviderAdapter: vi.fn() }));

// Both the production DESKTOP dispatcher and audio service remain unmocked.
import { registerDesktopHandlers } from '../../../src/host/ipc/desktop.ipc';
import * as desktopAudioCapture from '../../../src/host/services/desktop/desktopAudioCapture';

type Handler = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;

describe('DESKTOP startAudioCapture -> real desktopAudioCapture -> throwing VAD leaf', () => {
  let tempHome: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-vad-chain-'));
    leaves.userConfigDir = tempHome;
    vi.stubEnv('CODE_AGENT_HOME', tempHome);
    vi.stubEnv('CODE_AGENT_DATA_DIR', path.join(tempHome, 'data'));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64');
    const existingPaths = new Set([
      '/opt/homebrew/bin/ffmpeg',
      '/opt/homebrew/bin/whisper-cpp',
      path.join(tempHome, 'bin', 'system-audio-capture'),
    ]);
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => existingPaths.has(String(p)));
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => { throw new Error('command not found'); });
    vi.spyOn(childProcess, 'spawn').mockImplementation(() => { throw new Error('unexpected recorder spawn'); });
    leaves.loadVadRuntime.mockImplementation(() => { throw new Error('dlopen failed'); });
  });

  afterEach(() => {
    desktopAudioCapture.stopDesktopAudioCapture();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('call 1 fails AUDIO_START_FAILED/voice_detection_missing; call 2 fails again with a fresh VAD init (>=2 loads), never already-capturing success', async () => {
    expect(vi.isMockFunction(desktopAudioCapture.startDesktopAudioCapture)).toBe(false);
    expect(vi.isMockFunction(desktopAudioCapture.getAudioCaptureStatus)).toBe(false);
    const handlers = new Map<string, Handler>();
    registerDesktopHandlers({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never);
    const handler = handlers.get(IPC_DOMAINS.DESKTOP);
    expect(handler).toBeTypeOf('function');
    const request = { action: 'startAudioCapture', payload: { mode: 'microphone' } } as IPCRequest;
    const failure = {
      success: false,
      error: { code: 'AUDIO_START_FAILED', message: 'voice_detection_missing', details: { missingPrerequisites: ['voice_detection_missing'] } },
      data: { capturing: false, prerequisites: { voiceDetection: 'missing' }, missingPrerequisites: ['voice_detection_missing'] },
    };

    const first = await handler!(null, request);
    expect(first).toMatchObject(failure);
    const firstLoads = leaves.loadVadRuntime.mock.calls.length;
    // One load in VadProcessor.init, one in the real status/prerequisites service.
    expect(firstLoads).toBe(2);
    const second = await handler!(null, request);
    expect(second).toMatchObject(failure);
    expect(leaves.loadVadRuntime).toHaveBeenCalledTimes(firstLoads + 2);
    expect(leaves.loadVadRuntime.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(leaves.getRuntimeAssetsStatus).toHaveBeenCalledTimes(2);
    expect(leaves.prepareRuntimeAssetOnDemand).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });
});
