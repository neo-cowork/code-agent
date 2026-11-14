import childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as ort from 'onnxruntime-node';
import type { loadVadRuntime } from '../../../../src/host/services/desktop/audioVadRuntime';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadVadRuntime: vi.fn<typeof loadVadRuntime>(),
  userConfigDir: '/tmp/audio-prereq-config',
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../../src/host/services/desktop/audioVadRuntime', () => ({
  isOrtTensor: vi.fn(() => false),
  loadVadRuntime: mocks.loadVadRuntime,
}));

vi.mock('../../../../src/host/services/desktop/nativeDesktopService', () => ({
  getNativeDesktopService: () => ({ getStatus: () => ({ sqliteDbPath: null, running: false }) }),
}));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mocks.userConfigDir,
}));

import { getAudioCaptureStatus, startDesktopAudioCapture } from '../../../../src/host/services/desktop/desktopAudioCapture';
import { getAudioCapturePrerequisites } from '../../../../src/host/services/desktop/audioCapturePrerequisites';

const originalPlatform = process.platform;
const originalArch = process.arch;
const originalHome = process.env.CODE_AGENT_HOME;
const originalDataDir = process.env.CODE_AGENT_DATA_DIR;

function setRuntimeTarget(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  Object.defineProperty(process, 'arch', { configurable: true, value: arch });
}

describe('getAudioCaptureStatus prerequisites (computed without starting capture)', () => {
  let tempHome: string;
  let existingPaths: Set<string>;

  let whisperModels: string[] = [];
  beforeEach(() => {
    vi.restoreAllMocks();
    setRuntimeTarget('darwin', 'arm64');
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-prereq-home-'));
    process.env.CODE_AGENT_HOME = tempHome;
    process.env.CODE_AGENT_DATA_DIR = path.join(tempHome, 'data');
    mocks.userConfigDir = path.join(tempHome, '.code-agent');

    existingPaths = new Set<string>();

    vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
      return existingPaths.has(String(p));
    });
    // whisper 模型目录默认有一个模型；要测「缺模型」的用例把 whisperModels 清空
    whisperModels = ['ggml-base.bin'];
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike) =>
      String(p).endsWith(path.join('.cache', 'whisper')) ? whisperModels : []) as unknown as typeof fs.readdirSync);
    vi.spyOn(childProcess, 'execFileSync').mockImplementation((cmd) => {
      throw new Error(`which ${cmd} not found`);
    });

    mocks.loadVadRuntime.mockReturnValue({
      ok: true,
      ort,
      modelPath: '/fake/silero_vad_v5.onnx',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  afterAll(() => {
    setRuntimeTarget(originalPlatform, originalArch);
    if (originalHome === undefined) delete process.env.CODE_AGENT_HOME;
    else process.env.CODE_AGENT_HOME = originalHome;
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
  });

  it('all ready: returns empty missingPrerequisites when recorder, transcription engine, and voice detection are present', () => {
    existingPaths.add('/opt/homebrew/bin/ffmpeg');
    existingPaths.add(path.join(mocks.userConfigDir, 'bin', 'system-audio-capture'));
    existingPaths.add('/opt/homebrew/bin/whisper-cpp');

    const status = getAudioCaptureStatus();
    expect(status.capturing).toBe(false);
    expect(status.prerequisites).toEqual({
      recorder: { microphone: 'ready', systemAudio: 'ready' },
      transcriptionEngine: 'ready',
      voiceDetection: 'ready',
      missing: [],
    });
    expect(status.missingPrerequisites).toEqual([]);
    // Does not invoke swiftc
    expect(childProcess.execFileSync).not.toHaveBeenCalledWith('swiftc', expect.anything(), expect.anything());
  });

  it('system-audio mode: reports system_audio_helper_missing when helper binary is missing even if swift source exists', () => {
    existingPaths.add('/opt/homebrew/bin/ffmpeg');
    existingPaths.add('/opt/homebrew/bin/whisper-cpp');
    // Even if swift source exists, status check does not auto-compile via swiftc
    existingPaths.add(path.resolve(__dirname, '../../../../scripts/system-audio-capture.swift'));

    const status = getAudioCaptureStatus();
    expect(status.prerequisites.recorder).toEqual({
      microphone: 'ready',
      systemAudio: 'missing',
    });
    expect(childProcess.execFileSync).not.toHaveBeenCalledWith('swiftc', expect.anything(), expect.anything());
  });

  it('meeting mode: missing system audio helper is reported (capture degrades to microphone only), microphone mode ignores it', () => {
    existingPaths.add('/opt/homebrew/bin/ffmpeg');
    existingPaths.add('/opt/homebrew/bin/whisper-cpp');

    expect(getAudioCapturePrerequisites('meeting').missing).toContain('system_audio_helper_missing');
    expect(getAudioCapturePrerequisites('microphone').missing).not.toContain('system_audio_helper_missing');
  });

  it('whisper-cli (new Homebrew name) counts as the transcription engine', () => {
    existingPaths.add('/opt/homebrew/bin/ffmpeg');
    existingPaths.add('/opt/homebrew/bin/whisper-cli');
    expect(getAudioCapturePrerequisites('microphone').missing).not.toContain('transcription_engine_missing');
  });

  it('whisper program installed but no model: reports transcription_model_missing, not engine missing', () => {
    existingPaths.add('/opt/homebrew/bin/ffmpeg');
    existingPaths.add('/opt/homebrew/bin/whisper-cli');
    whisperModels = [];
    const missing = getAudioCapturePrerequisites('microphone').missing;
    expect(missing).toContain('transcription_model_missing');
    expect(missing).not.toContain('transcription_engine_missing');
  });

  it('recorder missing: reports recorder_missing when neither ffmpeg nor rec is available', () => {
    existingPaths.add('/opt/homebrew/bin/whisper-cpp');

    const status = getAudioCaptureStatus();
    expect(status.prerequisites.recorder).toEqual({
      microphone: 'missing',
      systemAudio: 'missing',
    });
    expect(status.missingPrerequisites).toEqual(['recorder_missing']);
  });

  it('transcription engine missing: reports transcription_engine_missing when neither whisper-cpp nor qwen3-asr exists', () => {
    existingPaths.add('/opt/homebrew/bin/ffmpeg');

    const status = getAudioCaptureStatus();
    expect(status.prerequisites.transcriptionEngine).toBe('missing');
    expect(status.asrEngine).toBe('none');
    expect(status.missingPrerequisites).toEqual(['transcription_engine_missing']);
  });

  it('voice-detection runtime missing (downloadable on darwin/arm64) and unsupported on darwin/x64', () => {
    existingPaths.add('/opt/homebrew/bin/ffmpeg');
    existingPaths.add('/opt/homebrew/bin/whisper-cpp');
    mocks.loadVadRuntime.mockReturnValue({
      ok: false,
      reason: 'missing-runtime',
      tauriNodeModules: '/missing/node_modules',
    });

    const arm64Status = getAudioCaptureStatus();
    expect(arm64Status.prerequisites.voiceDetection).toBe('downloadable');
    expect(arm64Status.missingPrerequisites).toEqual(['voice_detection_missing']);

    setRuntimeTarget('darwin', 'x64');
    const x64Status = getAudioCaptureStatus();
    expect(x64Status.prerequisites.voiceDetection).toBe('unsupported');
    expect(x64Status.missingPrerequisites).toEqual(['voice_detection_unsupported']);
  });
  it('voice-detection runtime load throws (broken native binding): status resolves and reports voice detection missing', () => {
    existingPaths.add('/opt/homebrew/bin/ffmpeg');
    existingPaths.add('/opt/homebrew/bin/whisper-cpp');
    mocks.loadVadRuntime.mockImplementation(() => {
      throw new Error('dlopen failed');
    });

    const status = getAudioCaptureStatus();
    expect(status.prerequisites.voiceDetection).toBe('missing');
    expect(status.missingPrerequisites).toEqual(['voice_detection_missing']);
  });

  it('a start attempt that hits the runtime throw leaves the service not capturing, so a second start is a fresh attempt', async () => {
    existingPaths.add('/opt/homebrew/bin/ffmpeg');
    existingPaths.add('/opt/homebrew/bin/whisper-cpp');
    mocks.loadVadRuntime.mockImplementation(() => {
      throw new Error('dlopen failed');
    });

    await startDesktopAudioCapture(undefined, 'microphone');
    expect(getAudioCaptureStatus().capturing).toBe(false);
    await startDesktopAudioCapture(undefined, 'microphone');
    expect(getAudioCaptureStatus().capturing).toBe(false);
    expect(mocks.loadVadRuntime.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
