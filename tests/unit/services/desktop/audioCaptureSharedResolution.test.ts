import fs from 'fs';
import os from 'os';
import path from 'path';
import * as ort from 'onnxruntime-node';
import type { InferenceSession } from 'onnxruntime-node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { loadVadRuntime } from '../../../../src/host/services/desktop/audioVadRuntime';

// 「设置里说就绪」和「真录音、真转写时用到的东西」必须是同一份：
// 录音程序（ffmpeg / rec）与 whisper 模型各只有一个查找入口，状态和实际执行都走它。
// 夹具全是真的：真目录、真文件、真的可执行脚本、真的 `which` 进程；只把本机已装的
// 同名程序藏起来（否则会在跑测试的机器上真的打开麦克风）。

const mocks = vi.hoisted(() => ({
  loadVadRuntime: vi.fn<typeof loadVadRuntime>(),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../src/host/services/desktop/audioVadRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/host/services/desktop/audioVadRuntime')>()),
  loadVadRuntime: mocks.loadVadRuntime,
}));
vi.mock('../../../../src/host/services/desktop/nativeDesktopService', () => ({
  getNativeDesktopService: () => ({ getStatus: () => ({}) }),
}));

type AudioCaptureModule = typeof import('../../../../src/host/services/desktop/desktopAudioCapture');
type PrerequisitesModule = typeof import('../../../../src/host/services/desktop/audioCapturePrerequisites');

const PROGRAM_NAMES = ['ffmpeg', 'rec', 'whisper-cli', 'whisper-cpp'];
const realExistsSync = fs.existsSync;
const originalEnv = {
  home: process.env.CODE_AGENT_HOME,
  dataDir: process.env.CODE_AGENT_DATA_DIR,
  path: process.env.PATH,
};

let capture: AudioCaptureModule;
let prerequisites: PrerequisitesModule;
let osHome = '';
let sandbox = '';
let neoHome = '';
let binDir = '';
/** 假装装在系统目录（/opt/homebrew/bin 等）里的程序；其余同名程序只认 sandbox 里的 */
let systemPrograms = new Set<string>();
let speechProbability = 0;
let vadRuns = 0;

/** 在 sandbox 的 PATH 目录里放一个真的可执行程序：记下每次被调用的参数，可选打印一行输出 */
function installProgram(name: string, stdoutLine = ''): void {
  const lines = ['#!/bin/sh', `printf '%s\\n' "$*" >> '${path.join(binDir, `${name}.calls`)}'`];
  if (stdoutLine) lines.push(`printf '%s\\n' '${stdoutLine}'`);
  fs.writeFileSync(path.join(binDir, name), `${lines.join('\n')}\n`, { mode: 0o755 });
}

function programCalls(name: string): string[] {
  const file = path.join(binDir, `${name}.calls`);
  return realExistsSync(file) ? fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean) : [];
}

beforeAll(async () => {
  // 操作系统的家目录换成空目录：机器上真有的 ~/.cache/whisper 不参与，结论只取决于夹具
  osHome = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-shared-os-home-'));
  vi.spyOn(os, 'homedir').mockReturnValue(osHome);
  capture = await import('../../../../src/host/services/desktop/desktopAudioCapture');
  prerequisites = await import('../../../../src/host/services/desktop/audioCapturePrerequisites');
});

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-shared-'));
  neoHome = path.join(sandbox, 'neo-home');
  binDir = path.join(sandbox, 'bin');
  fs.mkdirSync(neoHome, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  process.env.CODE_AGENT_HOME = neoHome;
  process.env.CODE_AGENT_DATA_DIR = path.join(sandbox, 'config');
  process.env.PATH = [binDir, '/usr/bin', '/bin'].join(path.delimiter);
  systemPrograms = new Set<string>();
  speechProbability = 0;
  vadRuns = 0;

  vi.spyOn(os, 'homedir').mockReturnValue(osHome);
  vi.spyOn(fs, 'existsSync').mockImplementation((target: fs.PathLike) => {
    const file = String(target);
    if (PROGRAM_NAMES.includes(path.basename(file)) && path.dirname(file) !== binDir) {
      return systemPrograms.has(file);
    }
    return realExistsSync(target);
  });

  // onnxruntime 用真模块（真 Tensor、真 InferenceSession 类），只把「加载模型文件」换成固定概率的会话
  const session = {
    run: async () => {
      vadRuns++;
      return {
        output: new ort.Tensor('float32', Float32Array.from([speechProbability]), [1, 1]),
        stateN: new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]),
      };
    },
  } as unknown as InferenceSession;
  vi.spyOn(ort.InferenceSession, 'create').mockResolvedValue(session);
  mocks.loadVadRuntime.mockReturnValue({ ok: true, ort, modelPath: path.join(sandbox, 'silero_vad_v5.onnx') });
});

afterEach(() => {
  capture.stopDesktopAudioCapture();
  vi.restoreAllMocks();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(osHome, { recursive: true, force: true });
  if (originalEnv.home === undefined) delete process.env.CODE_AGENT_HOME;
  else process.env.CODE_AGENT_HOME = originalEnv.home;
  if (originalEnv.dataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
  else process.env.CODE_AGENT_DATA_DIR = originalEnv.dataDir;
  process.env.PATH = originalEnv.path;
});

describe('whisper 模型：状态和真实转写读同一个目录', () => {
  it('CODE_AGENT_HOME 下有模型、状态说转写已就绪时，录下的一段话就是用这份模型转写的', async () => {
    const model = path.join(neoHome, '.cache', 'whisper', 'ggml-test.bin');
    fs.mkdirSync(path.dirname(model), { recursive: true });
    fs.writeFileSync(model, 'fixture');
    installProgram('ffmpeg');
    installProgram('whisper-cli', '[00:00:00.000 --> 00:00:01.000] hello');

    const ready = prerequisites.getAudioCapturePrerequisites('microphone');
    expect(ready.recorder.microphone).toBe('ready');
    expect(ready.transcriptionEngine).toBe('ready');
    const before = capture.getAudioCaptureStatus();
    expect(before.prerequisites.transcriptionEngine).toBe('ready');
    expect(before.missingPrerequisites).not.toContain('transcription_model_missing');

    // 一直在说话的 1.3 秒录音，停止时收尾成一段交去转写
    speechProbability = 0.9;
    const pcm = path.join(sandbox, 'in.pcm');
    fs.writeFileSync(pcm, Buffer.alloc(1024 * 40));
    await capture.startDesktopAudioCapture(pcm, 'microphone');
    await vi.waitFor(() => expect(vadRuns).toBe(40), { timeout: 5000 });
    capture.stopDesktopAudioCapture();

    await vi.waitFor(() => {
      expect(programCalls('whisper-cli'), '状态说转写已就绪，真实转写却没有用状态看到的那份模型').toEqual([
        expect.stringContaining(`-m ${model} `),
      ]);
    }, { timeout: 5000 });
    await vi.waitFor(() => {
      expect(capture.getAudioCaptureStatus().totalSegments).toBe(before.totalSegments + 1);
    }, { timeout: 5000 });
  });
});

describe('录音程序：状态和真实录音用同一个查找', () => {
  it.each([
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    '/opt/homebrew/bin/rec',
    '/usr/local/bin/rec',
    '/usr/bin/rec',
  ])('装在常见目录 %s、不在 PATH 里：状态就绪', (program) => {
    systemPrograms.add(program);

    expect(prerequisites.getAudioCapturePrerequisites('microphone').recorder.microphone).toBe('ready');
    const status = capture.getAudioCaptureStatus();
    expect(status.soxAvailable).toBe(true);
    expect(status.missingPrerequisites).not.toContain('recorder_missing');
  });

  it('只在 PATH 里、不在常见目录：状态就绪，开始录音起的就是这个 ffmpeg', async () => {
    installProgram('ffmpeg');

    expect(prerequisites.getAudioCapturePrerequisites('microphone').recorder.microphone).toBe('ready');
    await capture.startDesktopAudioCapture(undefined, 'microphone');

    expect(capture.getAudioCaptureStatus().capturing).toBe(true);
    await vi.waitFor(() => {
      expect(programCalls('ffmpeg').at(-1)).toMatch(/^-f avfoundation -i :0 .* pipe:1$/);
    }, { timeout: 5000 });
  });

  it('ffmpeg 和 rec 都没有：状态报缺录音组件，开始录音也起不来', async () => {
    expect(prerequisites.getAudioCapturePrerequisites('microphone').recorder.microphone).toBe('missing');
    expect(capture.getAudioCaptureStatus().missingPrerequisites).toContain('recorder_missing');

    await capture.startDesktopAudioCapture(undefined, 'microphone');

    expect(capture.getAudioCaptureStatus().capturing).toBe(false);
  });

  it('只有 rec：状态就绪，开始录音起的是 rec', async () => {
    installProgram('rec');

    expect(prerequisites.getAudioCapturePrerequisites('microphone').recorder.microphone).toBe('ready');
    await capture.startDesktopAudioCapture(undefined, 'microphone');

    expect(capture.getAudioCaptureStatus().capturing).toBe(true);
    await vi.waitFor(() => {
      expect(programCalls('rec')).toEqual([expect.stringMatching(/^-q -t raw -r 16000 -c 1 /)]);
    }, { timeout: 5000 });
  });

  it('ffmpeg 和 rec 都有：录音用 ffmpeg，不起 rec', async () => {
    installProgram('ffmpeg');
    installProgram('rec');

    await capture.startDesktopAudioCapture(undefined, 'microphone');

    await vi.waitFor(() => {
      expect(programCalls('ffmpeg').at(-1)).toMatch(/^-f avfoundation -i :0 /);
    }, { timeout: 5000 });
    expect(programCalls('rec')).toEqual([]);
  });
});
