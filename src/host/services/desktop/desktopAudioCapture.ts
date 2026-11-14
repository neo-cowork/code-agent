// ============================================================================
// DesktopAudioCapture - 后台音频采集 + VAD + ASR
// 使用 sox rec 采集麦克风 → avr-vad (Silero v5) 检测语音 → whisper-cpp/Qwen3-ASR 转录
// ============================================================================

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execFile, execFileSync, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../infra/logger';
import { getNativeDesktopService } from './nativeDesktopService';
import { getUserConfigDir } from '../../config/configPaths';
import { isOrtTensor, loadVadRuntime, type OrtRuntimeModule } from './audioVadRuntime';
import { getAudioCapturePrerequisites } from './audioCapturePrerequisites';
import { findWhisperBinary, whisperLanguageArgs } from '../media/whisperBinary';
import { clearAllAudioRecordings, finalizeSegmentAudio, getAudioRetentionStatus, sweepAudioRetention } from './audioRetention';
import { dropMicEchoes } from './audioCrossEcho';
import { AudioStreamClock } from './audioStreamClock';
import { AUDIO_SPEAKER_ID, type AudioCaptureMode } from '@shared/contract/audioCapture';
import type { InferenceSession, Tensor as OrtTensor } from 'onnxruntime-node';

const logger = createLogger('DesktopAudioCapture');
const execFileAsync = promisify(execFile);

// ============================================================================
// Config
// ============================================================================

const SAMPLE_RATE = 16000;
const BLOCK_SIZE = 512; // 512 samples = 32ms at 16kHz
const BLOCK_BYTES = BLOCK_SIZE * 2; // 16-bit = 2 bytes per sample

// VAD thresholds (Silero v5, matching meeting-cli's hysteresis)
const VAD_ONSET = 0.5; // start speech: high threshold
const VAD_OFFSET = 0.35; // end speech: lower threshold
const MIN_SPEECH_MS = 500; // minimum speech duration to keep
const MIN_SILENCE_MS = 2000; // 2s silence to finalize segment
const SPEECH_PAD_MS = 200; // pad speech boundaries
const VAD_CONTEXT_SAMPLES = 64; // Silero v5 16kHz 每块前拼的上下文样本数
const MAX_SPEECH_S = 15; // max segment duration, then smart-split

// ASR
const ASR_TIMEOUT_MS = 120_000;

// Power management check interval
const POWER_CHECK_INTERVAL_MS = 60_000;
const CAPTURE_KILL_GRACE_MS = 2_000;
const AUDIO_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

// Capture mode: microphone (default), system-audio (ScreenCaptureKit, captures headphone output),
// or meeting (both at once, tagged 我 / 对方)
type CaptureMode = AudioCaptureMode;
type CaptureSource = 'microphone' | 'system-audio' | 'fifo';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBooleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ffmpeg paths — 使用 AVFoundation 采集（sox CoreAudio 在 Tauri 子进程中无法获取 TCC 权限）
const FFMPEG_PATHS = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
// sox/rec paths — 仅用于 soxAvailable 检测（实际采集改用 ffmpeg）
const REC_PATHS = ['/opt/homebrew/bin/rec', '/usr/local/bin/rec', '/usr/bin/rec'];
// system-audio-capture Swift tool (ScreenCaptureKit)
const SYSTEM_AUDIO_CAPTURE_NAME = 'system-audio-capture';

// Whisper-cpp paths
const WHISPER_MODEL_DIR = path.join(os.homedir(), '.cache', 'whisper');
const WHISPER_DEFAULT_MODEL = 'ggml-large-v3-turbo.bin';

// Qwen3-ASR paths
const QWEN_ASR_PATHS = [
  path.join(os.homedir(), 'Library/Application Support/net.bytenote.asro/models/qwen3-asr-0.6b'),
  path.join(os.homedir(), '.cache/huggingface/hub/models--Qwen--Qwen3-ASR-0.6B/snapshots'),
];
// Python3 候选路径 — Tauri 子进程不继承 shell PATH，需要显式查找
const PYTHON3_PATHS = [
  '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3',
  '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3',
  '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3',
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  '/usr/bin/python3',
];

// ============================================================================
// State
// ============================================================================

/** 一路采集：自己的进程/流 + 自己的 VAD 状态（两路共用一个 VAD 会把隐藏状态搅在一起） */
interface CaptureTrack {
  source: CaptureSource;
  speakerId: number;
  vad: VadProcessor;
  proc: ChildProcess | null;
  stream: fs.ReadStream | null;
  /** 这一路 VAD 的处理链：进程重启后新旧两条流也排在同一条链上，不并发推理 */
  vadChain: Promise<void>;
}

let tracks: CaptureTrack[] = [];
let capturing = false;
let captureMode: CaptureMode = 'microphone';
/** 用户选的模式；会议模式缺系统音频组件时 captureMode 会降成 microphone，这里留原值给界面说明 */
let requestedMode: CaptureMode = 'microphone';
let powerMode: 'full' | 'reduced' | 'paused' = 'full';
let powerCheckTimer: ReturnType<typeof setInterval> | null = null;
let audioRetentionTimer: ReturnType<typeof setInterval> | null = null;
let totalSegments = 0;
const asrQueue: Array<{ wavPath: string; startMs: number; endMs: number; speakerId: number }> = [];
let recBinaryPath: string | null = null; // 缓存 rec 二进制路径
let ffmpegBinaryPath: string | null = null; // 缓存 ffmpeg 二进制路径
let systemAudioBinaryPath: string | null = null; // 缓存 system-audio-capture 路径
let asrProcessing = 0; // number of concurrent ASR workers
const ASR_MAX_CONCURRENCY = 3; // run up to 3 ASR processes in parallel

/** 查找 ffmpeg 二进制 */
function findFfmpegBinary(): string | null {
  if (ffmpegBinaryPath) return ffmpegBinaryPath;
  for (const p of FFMPEG_PATHS) {
    if (fs.existsSync(p)) { ffmpegBinaryPath = p; return p; }
  }
  try {
    ffmpegBinaryPath = execFileSync('which', ['ffmpeg'], { encoding: 'utf-8' }).trim();
    return ffmpegBinaryPath;
  } catch {
    return null;
  }
}

/** 查找或编译 system-audio-capture（ScreenCaptureKit 系统音频采集工具） */
function findSystemAudioCaptureBinary(): string | null {
  if (systemAudioBinaryPath) return systemAudioBinaryPath;

  // 查找预编译二进制（开发目录 → Tauri Resources → 用户 bin）
  const scriptDir = path.join(__dirname, '..', '..', '..', 'scripts');
  const candidates = [
    path.join(scriptDir, SYSTEM_AUDIO_CAPTURE_NAME),
    // Tauri 打包后: __dirname = Resources/_up_/dist/web/, binary = Resources/_up_/scripts/
    path.join(__dirname, '..', '..', 'scripts', SYSTEM_AUDIO_CAPTURE_NAME),
    path.join(getUserConfigDir(), 'bin', SYSTEM_AUDIO_CAPTURE_NAME),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      systemAudioBinaryPath = p;
      return p;
    }
  }

  // 尝试自动编译
  const swiftSource = path.join(scriptDir, `${SYSTEM_AUDIO_CAPTURE_NAME}.swift`);
  if (fs.existsSync(swiftSource)) {
    const outputPath = path.join(scriptDir, SYSTEM_AUDIO_CAPTURE_NAME);
    try {
      logger.info('[音频采集] 编译 system-audio-capture...');
      execFileSync('swiftc', [
        '-O', '-framework', 'ScreenCaptureKit', '-framework', 'AVFoundation',
        '-framework', 'CoreMedia', '-o', outputPath, swiftSource,
      ], { encoding: 'utf-8', timeout: 120_000 });
      systemAudioBinaryPath = outputPath;
      logger.info('[音频采集] system-audio-capture 编译成功');
      return outputPath;
    } catch (error) {
      logger.error('[音频采集] system-audio-capture 编译失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
}

/** 查找 rec 二进制 — 仅用于兼容性检查 */
function findRecBinary(): string | null {
  if (recBinaryPath) return recBinaryPath;
  for (const p of REC_PATHS) {
    if (fs.existsSync(p)) { recBinaryPath = p; return p; }
  }
  try {
    recBinaryPath = execFileSync('which', ['rec'], { encoding: 'utf-8' }).trim();
    return recBinaryPath;
  } catch {
    return null;
  }
}

// ============================================================================
// VAD State Machine (ported from meeting-cli VadEngine)
// ============================================================================

export class VadStateMachine {
  private speechActive = false;
  private speechBuffer: number[] = [];
  private speechSamples = 0;
  private silenceSamples = 0;
  private probHistory: number[] = [];
  private pendingPad: number[] = [];
  /** speechBuffer 开头那段补白的样本数：probHistory[0] 对应的块从这里开始 */
  private leadSamples = 0;

  private readonly onset: number;
  private readonly offset: number;
  private readonly minSpeechSamples: number;
  private readonly minSilenceSamples: number;
  private readonly speechPadSamples: number;
  private readonly maxSpeechSamples: number;

  constructor(onset = VAD_ONSET, offset = VAD_OFFSET) {
    this.onset = onset;
    this.offset = offset;
    this.minSpeechSamples = Math.floor(MIN_SPEECH_MS * SAMPLE_RATE / 1000);
    this.minSilenceSamples = Math.floor(MIN_SILENCE_MS * SAMPLE_RATE / 1000);
    this.speechPadSamples = Math.floor(SPEECH_PAD_MS * SAMPLE_RATE / 1000);
    this.maxSpeechSamples = Math.floor(MAX_SPEECH_S * SAMPLE_RATE);
  }

  processChunk(pcmInt16: Int16Array, prob: number): Int16Array[] {
    const completed: Int16Array[] = [];
    const chunkLen = pcmInt16.length;

    // Hysteresis: use onset to START speech, offset to END speech
    const isSpeech = this.speechActive ? prob >= this.offset : prob >= this.onset;

    if (isSpeech) {
      if (!this.speechActive) {
        // Speech onset
        this.speechActive = true;
        this.speechBuffer = [...this.pendingPad];
        this.leadSamples = this.pendingPad.length;
        this.speechSamples = this.speechBuffer.length;
        this.silenceSamples = 0;
        this.probHistory = [];
      }

      for (let i = 0; i < pcmInt16.length; i++) {
        this.speechBuffer.push(pcmInt16[i]);
      }
      this.speechSamples += chunkLen;
      this.silenceSamples = 0;
      this.probHistory.push(prob);

      // Smart max-duration split
      if (this.speechSamples >= this.maxSpeechSamples) {
        const segment = this.smartSplit();
        if (segment) completed.push(segment);
      }
    } else {
      if (this.speechActive) {
        for (let i = 0; i < pcmInt16.length; i++) {
          this.speechBuffer.push(pcmInt16[i]);
        }
        this.silenceSamples += chunkLen;
        this.probHistory.push(prob);

        if (this.silenceSamples >= this.minSilenceSamples) {
          // Silence long enough → finalize segment
          if (this.speechSamples >= this.minSpeechSamples) {
            completed.push(new Int16Array(this.speechBuffer));
          }
          this.speechActive = false;
          this.speechBuffer = [];
          this.speechSamples = 0;
          this.silenceSamples = 0;
          this.probHistory = [];
        }
        // Short gaps (breathing) → keep buffering
      }
    }

    // 滚动保留最近 speechPadSamples 个样本，开口时补在段落前面。原来只取本块的尾巴，
    // 一块只有 512 样本，实际只补 32ms，每句开头被吃字（N-MEETING-DUALTRACK-FU2）
    this.pendingPad = this.pendingPad.concat(Array.from(pcmInt16)).slice(-this.speechPadSamples);

    return completed;
  }

  private smartSplit(): Int16Array | null {
    if (this.probHistory.length === 0) {
      const seg = new Int16Array(this.speechBuffer);
      this.speechBuffer = [];
      this.speechSamples = 0;
      this.probHistory = [];
      return seg;
    }

    // Find lowest-prob chunk in second half
    const half = Math.floor(this.probHistory.length / 2);
    const secondHalf = this.probHistory.slice(half);
    let minIdx = half;
    let minVal = secondHalf[0];
    for (let i = 1; i < secondHalf.length; i++) {
      if (secondHalf[i] < minVal) {
        minVal = secondHalf[i];
        minIdx = half + i;
      }
    }

    // 切在最安静那块的开头：要跳过段首补白，否则切点提前补白那么长、切进字中间
    const splitSample = this.leadSamples + minIdx * BLOCK_SIZE;
    if (splitSample <= 0 || splitSample >= this.speechBuffer.length) {
      const seg = new Int16Array(this.speechBuffer);
      this.speechBuffer = [];
      this.speechSamples = 0;
      this.probHistory = [];
      return seg;
    }

    const firstPart = new Int16Array(this.speechBuffer.slice(0, splitSample));
    this.speechBuffer = this.speechBuffer.slice(splitSample);
    this.speechSamples = this.speechBuffer.length;
    this.probHistory = this.probHistory.slice(minIdx);
    this.leadSamples = 0; // 剩下的从最安静那块开头起，不再带补白
    return firstPart;
  }

  get isSpeaking(): boolean {
    return this.speechActive;
  }
}

// ============================================================================
// Silero VAD v5 Processor (direct ONNX Runtime, no wrapper)
// ============================================================================

class VadProcessor {
  private session: InferenceSession | null = null;
  private ort: OrtRuntimeModule | null = null;
  private state: OrtTensor | null = null; // hidden state carried across frames
  // Silero v5 在 16kHz 下每块前要拼上一块最后 64 个样本（官方用法），不拼时开口检测偏晚（N-MEETING-DUALTRACK-FU2）
  private context = new Float32Array(VAD_CONTEXT_SAMPLES);
  private stateMachine: VadStateMachine;
  private initialized = false;

  constructor() {
    this.stateMachine = new VadStateMachine();
  }

  async init(): Promise<boolean> {
    try {
      const runtime = loadVadRuntime(__dirname);
      if (!runtime.ok && runtime.reason === 'missing-runtime') {
        const message = process.platform === 'darwin' && process.arch === 'x64'
          ? '[音频采集] Intel Mac 不支持 VAD 运行组件，桌面环境音采集未启动'
          : '[音频采集] 本地推理运行时缺失（onnxruntime 按需资产未安装），桌面环境音采集未启动';
        logger.warn(message, {
          module: 'onnxruntime-node',
          platform: process.platform,
          arch: process.arch,
        });
        return false;
      }
      if (!runtime.ok) {
        logger.warn('[音频采集] Silero VAD v5 模型文件不存在', {
          modelPath: runtime.modelPath,
          tauriNodeModules: runtime.tauriNodeModules,
        });
        return false;
      }
      this.ort = runtime.ort;
      this.session = await this.ort.InferenceSession.create(runtime.modelPath);
      // Initialize hidden state: [2, 1, 128] zeros
      this.state = new this.ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
      this.initialized = true;
      logger.info('[音频采集] VAD (Silero v5 ONNX) 初始化成功');
      return true;
    } catch (error) {
      logger.error('[音频采集] VAD 初始化失败', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return false;
    }
  }

  private probLogCount = 0;

  async processChunk(pcmInt16: Int16Array): Promise<Int16Array[]> {
    if (!this.initialized) return [];
    if (!this.ort || !this.session || !this.state) return [];

    // Convert Int16 to Float32 [-1.0, 1.0]，前面拼上一块的最后 64 个样本
    const float32 = new Float32Array(VAD_CONTEXT_SAMPLES + pcmInt16.length);
    float32.set(this.context);
    for (let i = 0; i < pcmInt16.length; i++) {
      float32[VAD_CONTEXT_SAMPLES + i] = pcmInt16[i] / 32768.0;
    }
    // Run Silero v5: input=[1, 64 + chunk_size], state=[2,1,128], sr=scalar
    const input = new this.ort.Tensor('float32', float32, [1, float32.length]);
    const sr = new this.ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);

    const result = await this.session.run({ input, state: this.state, sr });
    const output = result.output;
    const stateN = result.stateN;
    if (!isOrtTensor(output) || !(output.data instanceof Float32Array) || !isOrtTensor(stateN)) {
      logger.warn('[VAD] ONNX 输出格式异常');
      return [];
    }
    const prob = output.data[0] ?? 0;
    this.state = stateN; // carry hidden state forward
    this.context = float32.slice(float32.length - VAD_CONTEXT_SAMPLES); // 和隐藏状态一起前进，推理失败时两者不错开

    // 每 500 次（约 16 秒）输出一次 VAD 概率
    this.probLogCount++;
    if (this.probLogCount % 500 === 0) {
      let maxAmp = 0;
      for (let i = 0; i < pcmInt16.length; i++) {
        const abs = Math.abs(pcmInt16[i]);
        if (abs > maxAmp) maxAmp = abs;
      }
      logger.debug('[VAD] 概率采样', {
        prob: prob.toFixed(4),
        maxAmp,
        speaking: this.stateMachine.isSpeaking,
        chunks: this.probLogCount,
      });
    }

    return this.stateMachine.processChunk(pcmInt16, prob);
  }

  get isSpeaking(): boolean {
    return this.stateMachine.isSpeaking;
  }
}

// ============================================================================
// WAV File Operations
// ============================================================================

function getAudioDir(): string {
  const service = getNativeDesktopService();
  const status = service.getStatus();
  const root = status.sqliteDbPath
    ? path.dirname(status.sqliteDbPath)
    : path.join(getUserConfigDir(), 'native-desktop');
  return path.join(root, 'audio');
}

function getDailyAudioDir(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dir = path.join(getAudioDir(), today);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** 两路可能在同一毫秒切出一段，会议模式的文件名和行 id 带说话人后缀防撞 */
function segmentKey(startMs: number, speakerId: number): string {
  return speakerId === AUDIO_SPEAKER_ID.UNKNOWN ? `${startMs}` : `${startMs}-s${speakerId}`;
}

function saveWavFile(pcm: Int16Array, startMs: number, speakerId: number): string {
  const dir = getDailyAudioDir();
  const filename = `audio_${segmentKey(startMs, speakerId)}.wav`;
  const wavPath = path.join(dir, filename);

  // Write WAV header + PCM data
  const dataBytes = pcm.length * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);

  const pcmBuffer = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  fs.writeFileSync(wavPath, Buffer.concat([header, pcmBuffer]));
  return wavPath;
}

// ============================================================================
// ASR (Transcription)
// ============================================================================

function findWhisperModel(): string | null {
  const modelPath = path.join(WHISPER_MODEL_DIR, WHISPER_DEFAULT_MODEL);
  if (fs.existsSync(modelPath)) return modelPath;
  // Check for any ggml model
  if (fs.existsSync(WHISPER_MODEL_DIR)) {
    const files = fs.readdirSync(WHISPER_MODEL_DIR).filter(f => f.startsWith('ggml-') && f.endsWith('.bin'));
    if (files.length > 0) return path.join(WHISPER_MODEL_DIR, files[0]);
  }
  return null;
}

function findQwenAsrModel(): string | null {
  for (const p of QWEN_ASR_PATHS) {
    if (fs.existsSync(p)) {
      // Check for snapshots directory (huggingface cache)
      if (p.includes('snapshots')) {
        const versions = fs.readdirSync(p).filter(f => !f.startsWith('.'));
        if (versions.length > 0) return path.join(p, versions[versions.length - 1]);
      }
      if (fs.existsSync(path.join(p, 'model.safetensors'))) return p;
    }
  }
  return null;
}

async function transcribeWithWhisperCpp(wavPath: string): Promise<string | null> {
  const binary = findWhisperBinary();
  const model = findWhisperModel();
  if (!binary || !model) return null;

  try {
    // 必须异步：同步调用会把整个事件循环卡住十几秒（大模型首段），两路音频在管道里积压，
    // 段落时间戳整体后移、积压的语音会丢，同进程的网页服务也跟着卡（11-14 真机实测 18.5 秒）
    const { stdout: result } = await execFileAsync(binary, [
      '-m', model, '-f', wavPath, ...whisperLanguageArgs('zh'), '-t', '4', '--no-prints',
    ], { encoding: 'utf-8', timeout: ASR_TIMEOUT_MS });

    // Parse output: [timestamp] text
    const lines = result.split('\n');
    const textParts: string[] = [];
    for (const line of lines) {
      const match = line.trim().match(/^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*(.*)$/);
      if (match?.[1]) textParts.push(match[1].trim());
      else if (line.trim() && !line.trim().startsWith('[')) textParts.push(line.trim());
    }
    return textParts.join(' ').trim() || null;
  } catch (error) {
    logger.warn('[音频ASR] whisper-cpp 失败', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 查找安装了 qwen_asr 的 python3 路径（Tauri 子进程不继承 shell PATH） */
let python3BinaryPath: string | null = null;
function findPython3WithQwenAsr(): string | null {
  if (python3BinaryPath) return python3BinaryPath;
  for (const p of PYTHON3_PATHS) {
    if (!fs.existsSync(p)) continue;
    try {
      execFileSync(p, ['-c', 'import qwen_asr'], { encoding: 'utf-8', timeout: 10_000 });
      python3BinaryPath = p;
      logger.info('[音频ASR] 找到 python3', { path: p });
      return p;
    } catch { /* try next */ }
  }
  return null;
}

async function transcribeWithQwenAsr(wavPath: string): Promise<string | null> {
  const modelPath = findQwenAsrModel();
  if (!modelPath) return null;

  const python3 = findPython3WithQwenAsr();
  if (!python3) {
    logger.warn('[音频ASR] 未找到安装了 qwen_asr 的 python3');
    return null;
  }

  const script = `
import sys, json
from qwen_asr import Qwen3ASRModel
import torch
model = Qwen3ASRModel.from_pretrained("${modelPath.replace(/"/g, '\\"')}", dtype=torch.float32, device_map="cpu")
result = model.transcribe("${wavPath.replace(/"/g, '\\"')}")
text = result[0].text if isinstance(result, list) and len(result) > 0 else str(result)
print(json.dumps({"text": text}))
`;

  // 使用异步 spawn 避免阻塞事件循环（execFileSync 会阻塞 30-60s）
  return new Promise<string | null>((resolve) => {
    const proc = spawn(python3, ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout!.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr!.on('data', (data: Buffer) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      logger.warn('[音频ASR] Qwen3-ASR 超时');
      resolve(null);
    }, ASR_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        logger.warn('[音频ASR] Qwen3-ASR 失败', { code, stderr: stderr.slice(0, 200) });
        resolve(null);
        return;
      }
      const parsed = parseJsonRecord(stdout.trim());
      const text = readStringField(parsed, 'text');
      if (text) {
        resolve(text);
      } else {
        logger.warn('[音频ASR] Qwen3-ASR 输出解析失败', { stdout: stdout.slice(0, 200) });
        resolve(null);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      logger.warn('[音频ASR] Qwen3-ASR 进程错误', { error: err.message });
      resolve(null);
    });
  });
}

async function transcribeSegment(wavPath: string): Promise<{ text: string | null; engine: string }> {
  // Fallback chain: whisper-cpp → Qwen3-ASR
  const whisperResult = await transcribeWithWhisperCpp(wavPath);
  if (whisperResult) return { text: whisperResult, engine: 'whisper-cpp' };

  const qwenResult = await transcribeWithQwenAsr(wavPath);
  if (qwenResult) return { text: qwenResult, engine: 'qwen3-asr' };

  return { text: null, engine: 'none' };
}

// ============================================================================
// SQLite Persistence
// ============================================================================

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * 录音库路径。库文件平时由桌面活动采集器（Rust）创建；没开过采集器时这里自己建，
 * 否则转写只落 wav、不入库也没提示（N-MEETING-SESSION 前提）。Rust 侧建表都是 IF NOT EXISTS，先建无妨。
 */
export function getSqlitePath(): string | null {
  const service = getNativeDesktopService();
  const dbPath = service.getStatus().sqliteDbPath;
  if (!dbPath) return null;
  if (!fs.existsSync(dbPath)) {
    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      ensureAudioTable(dbPath);
      logger.info('[音频采集] 录音库不存在，已新建', { dbPath });
    } catch (error) {
      logger.warn('[音频采集] 新建录音库失败', { dbPath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return fs.existsSync(dbPath) ? dbPath : null;
}

export function ensureAudioTable(sqlitePath: string): void {
  const sql = `
CREATE TABLE IF NOT EXISTS audio_segments (
  id TEXT PRIMARY KEY,
  start_at_ms INTEGER NOT NULL,
  end_at_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  wav_path TEXT,
  transcript TEXT,
  speaker_id INTEGER DEFAULT 0,
  asr_engine TEXT,
  asr_duration_ms INTEGER,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_start ON audio_segments (start_at_ms DESC);
`;
  try {
    execFileSync('sqlite3', [sqlitePath, sql], { encoding: 'utf-8' });
  } catch (error) {
    logger.warn('[音频采集] 创建 audio_segments 表失败', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function persistAudioSegment(
  sqlitePath: string,
  segment: {
    id: string;
    startAtMs: number;
    endAtMs: number;
    durationMs: number;
    wavPath: string;
    transcript: string | null;
    speakerId: number;
    asrEngine: string;
    asrDurationMs: number;
  },
  createdAtMs: number = Date.now(),
): boolean {
  const transcript = segment.transcript ? `'${sqlEscape(segment.transcript)}'` : 'NULL';
  const sql = `INSERT OR REPLACE INTO audio_segments (id, start_at_ms, end_at_ms, duration_ms, wav_path, transcript, speaker_id, asr_engine, asr_duration_ms, created_at_ms) VALUES ('${sqlEscape(segment.id)}', ${segment.startAtMs}, ${segment.endAtMs}, ${segment.durationMs}, '${sqlEscape(segment.wavPath)}', ${transcript}, ${Math.trunc(segment.speakerId)}, '${sqlEscape(segment.asrEngine)}', ${segment.asrDurationMs}, ${createdAtMs});`;
  try {
    execFileSync('sqlite3', [sqlitePath, sql], { encoding: 'utf-8' });
    return true;
  } catch (error) {
    logger.warn('[音频采集] 写入 audio_segments 失败', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// ============================================================================
// ASR Queue Processor
// ============================================================================

async function processOneAsrItem(): Promise<void> {
  const item = asrQueue.shift();
  if (!item) return;

  asrProcessing++;
  try {
    const asrStart = Date.now();
    const { text, engine } = await transcribeSegment(item.wavPath);
    const asrDuration = Date.now() - asrStart;

    const sqlitePath = getSqlitePath();
    if (sqlitePath) {
      const segmentId = `audio-${segmentKey(item.startMs, item.speakerId)}`;
      const persisted = persistAudioSegment(sqlitePath, {
        id: segmentId,
        startAtMs: item.startMs,
        endAtMs: item.endMs,
        durationMs: item.endMs - item.startMs,
        wavPath: item.wavPath,
        transcript: text,
        speakerId: item.speakerId,
        asrEngine: engine,
        asrDurationMs: asrDuration,
      });
      if (persisted && text) {
        finalizeSegmentAudio({ sqlitePath, audioDir: getAudioDir(), segmentId, wavPath: item.wavPath });
        // 两路各自转写、先后不定：哪一路落库都回头查一次同时段的另一路
        if (item.speakerId !== AUDIO_SPEAKER_ID.UNKNOWN) dropMicEchoes(sqlitePath, item.startMs, item.endMs);
      }
    }

    if (text) {
      totalSegments++;
      logger.info('[音频ASR] 转录完成', {
        engine,
        duration: `${item.endMs - item.startMs}ms`,
        textLength: text.length,
        asrTime: `${asrDuration}ms`,
        queueRemaining: asrQueue.length,
        workers: asrProcessing,
      });
    }
  } finally {
    asrProcessing--;
    // Continue draining the queue
    if (asrQueue.length > 0 && asrProcessing < ASR_MAX_CONCURRENCY) {
      processAsrQueue().catch(() => {});
    }
  }
}

async function processAsrQueue(): Promise<void> {
  // Launch workers up to concurrency limit
  while (asrQueue.length > 0 && asrProcessing < ASR_MAX_CONCURRENCY) {
    processOneAsrItem().catch(() => {});
  }
}

// ============================================================================
// Power Management
// ============================================================================

function checkPowerState(): 'full' | 'reduced' | 'paused' {
  try {
    const service = getNativeDesktopService();
    const status = service.getStatus();
    const sqlitePath = status.sqliteDbPath;
    if (!sqlitePath || !fs.existsSync(sqlitePath)) return 'full';

    const output = execFileSync('sqlite3', ['-json', sqlitePath,
      "SELECT raw_json FROM desktop_activity_events ORDER BY captured_at_ms DESC LIMIT 1;",
    ], { encoding: 'utf-8' }).trim();
    if (!output) return 'full';

    const rows = parseJsonArray(output);
    if (rows.length === 0) return 'full';
    const row = rows[0];
    if (!isRecord(row)) return 'full';
    const rawJson = readStringField(row, 'raw_json');
    if (!rawJson) return 'full';
    const event = parseJsonRecord(rawJson);

    if (readBooleanField(event, 'onAcPower')) return 'full';
    const battery = readNumberField(event, 'batteryPercent');
    if (battery != null && battery < 20) return 'paused';
    if (battery != null && battery < 50) return 'reduced';
    return 'full';
  } catch {
    return 'full';
  }
}

// ============================================================================
// Core Audio Capture
// ============================================================================

/** 自动检测可用的 AVFoundation 音频输入设备索引（跳过虚拟设备和断开的蓝牙） */
function detectAudioDeviceIndex(): string {
  const ffmpegBin = findFfmpegBinary();
  if (!ffmpegBin) return ':0';

  try {
    // ffmpeg -list_devices 输出在 stderr
    const result = execFileSync(ffmpegBin, [
      '-f', 'avfoundation', '-list_devices', 'true', '-i', '',
    ], { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    return parseAudioDevices(result);
  } catch (error: unknown) {
    // ffmpeg -list_devices always exits with error, but output is in stderr
    const stderr = (error as { stderr?: string })?.stderr || '';
    return parseAudioDevices(stderr);
  }
}

/** 解析 ffmpeg 设备列表，返回最佳音频输入设备索引 */
function parseAudioDevices(output: string): string {
  const lines = output.split('\n');
  let inAudio = false;
  const devices: Array<{ index: number; name: string }> = [];
  // 虚拟设备 — 不用于录音
  const virtualDevices = new Set(['BlackHole', 'LarkAudioDevice', 'Microsoft Teams Audio', 'Soundflower']);

  for (const line of lines) {
    if (line.includes('AVFoundation audio devices:')) { inAudio = true; continue; }
    if (inAudio) {
      const match = line.match(/\[(\d+)\]\s+(.+)/);
      if (match) {
        devices.push({ index: parseInt(match[1], 10), name: match[2].trim() });
      }
    }
  }

  if (devices.length === 0) return ':0';

  // 优先内置麦克风，其次非虚拟设备
  const builtin = devices.find(d => d.name.includes('MacBook') && d.name.includes('Microphone'));
  if (builtin) {
    logger.info('[音频采集] 选择内置麦克风', { index: builtin.index, name: builtin.name });
    return `:${builtin.index}`;
  }

  const real = devices.filter(d => !virtualDevices.has(d.name) && !d.name.includes('BlackHole'));
  if (real.length > 0) {
    logger.info('[音频采集] 选择可用麦克风', { index: real[0].index, name: real[0].name });
    return `:${real[0].index}`;
  }

  return `:${devices[0].index}`;
}

/** 起一路采集进程：麦克风走 ffmpeg AVFoundation（fallback sox rec），系统音频走 ScreenCaptureKit 工具 */
function spawnSource(source: 'microphone' | 'system-audio'): ChildProcess | null {
  if (source === 'system-audio') {
    const sysAudioBin = findSystemAudioCaptureBinary();
    if (!sysAudioBin) return null;
    logger.info('[音频采集] 使用 ScreenCaptureKit 系统音频模式');
    return spawn(sysAudioBin, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  // 麦克风：优先使用 ffmpeg + AVFoundation（macOS TCC 兼容），fallback 到 sox rec
  const ffmpegBin = findFfmpegBinary();
  if (ffmpegBin) {
    const audioDevice = detectAudioDeviceIndex();
    logger.info('[音频采集] 使用 ffmpeg AVFoundation 模式', { device: audioDevice });
    return spawn(ffmpegBin, [
      '-f', 'avfoundation', '-i', audioDevice,
      // avfoundation 会丢帧（11-14 本机实测只出实时的 0.88 倍），段落时间按样本数推算会越录越早；
      // 按时间戳把缺口补成静音，样本数才和墙钟对得上（N-MEETING-DUALTRACK-FU1）
      // ponytail: 只覆盖 ffmpeg；sox rec 回落和 Tauri FIFO 路径若也丢帧仍会偏早，遇到再补
      '-af', 'aresample=async=1',
      '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  logger.warn('[音频采集] ffmpeg 不可用，fallback 到 sox rec');
  const recBin = findRecBinary() || 'rec';
  return spawn(recBin, [
    '-q', '-t', 'raw', '-r', String(SAMPLE_RATE), '-c', '1', '-b', '16', '-e', 'signed-integer', '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 一路 16kHz mono s16le 流 → VAD 切段 → 落 wav → 排队转写（两路各一份，互不干扰） */
function pumpPcm(input: NodeJS.ReadableStream, track: CaptureTrack): void {
  let accumBuffer = Buffer.alloc(0);
  let vadErrorLogged = false;
  let dataChunkCount = 0;
  let lastDiagMs = 0;
  // 每条流一个时钟：进程重启后新流首包重新定原点，重启空窗不会让后续段落整体偏早
  const clock = new AudioStreamClock(SAMPLE_RATE);

  // 一路的数据包必须逐个处理完再处理下一个：VAD 带隐藏状态，主线程一卡、积压的包并发进
  // session.run 会共用旧状态，段落被错合/错切，时间偏出好几秒（N-MEETING-DUALTRACK-FU1 真机实测）。
  // ponytail: 处理长期跟不上实时时队列会一直涨，真遇到再加丢包/降级
  input.on('data', (data: Buffer | string) => {
    if (typeof data === 'string') return; // skip string chunks
    clock.receive(data.length); // 原点按到达时刻定，不能等排队
    track.vadChain = track.vadChain.then(() => handlePcm(data)).catch((error) => {
      logger.error('[音频采集] 处理音频数据异常', { source: track.source, error: error instanceof Error ? error.message : String(error) });
    });
  });

  async function handlePcm(data: Buffer): Promise<void> {
    if (powerMode === 'paused') {
      clock.advance(data.length / 2); // 丢掉的样本也算时间，恢复后不漂
      return;
    }
    // 已停掉的一路：进程哪怕还没退干净，数据也不再落库（否则停了又开会多出一路「对方」）
    if (!tracks.includes(track)) return;

    dataChunkCount++;
    if (dataChunkCount === 1) {
      logger.debug('[音频采集] 首次收到音频数据', { source: track.source, bytes: data.length });
    }

    // 每 10 秒输出一次音频振幅诊断
    const now = Date.now();
    if (now - lastDiagMs > 10_000) {
      lastDiagMs = now;
      const int16View = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + Math.min(data.length, 1024)));
      let maxAmp = 0;
      for (let i = 0; i < int16View.length; i++) {
        const abs = Math.abs(int16View[i]);
        if (abs > maxAmp) maxAmp = abs;
      }
      logger.debug('[音频采集] 振幅诊断', {
        source: track.source,
        chunks: dataChunkCount,
        maxAmp,
        maxAmpPct: `${(maxAmp / 32768 * 100).toFixed(1)}%`,
        vadSpeaking: track.vad.isSpeaking,
      });
    }

    accumBuffer = Buffer.concat([accumBuffer, data]);

    while (accumBuffer.length >= BLOCK_BYTES) {
      const chunk = accumBuffer.subarray(0, BLOCK_BYTES);
      accumBuffer = accumBuffer.subarray(BLOCK_BYTES);

      const int16 = new Int16Array(
        chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + BLOCK_BYTES)
      );

      // 这一块样本对应的音频时刻；段落在这块处切出，就以它为结束时间
      const blockEndMs = clock.advance(BLOCK_SIZE);
      try {
        const segments = await track.vad.processChunk(int16);
        for (const segment of segments) {
          const endMs = blockEndMs;
          const durationMs = Math.round((segment.length / SAMPLE_RATE) * 1000);
          const startMs = endMs - durationMs;

          // Save WAV and queue for ASR
          try {
            const wavPath = saveWavFile(segment, startMs, track.speakerId);
            logger.debug('[音频采集] 语音段完成', {
              source: track.source,
              duration: `${durationMs}ms`,
              samples: segment.length,
              file: path.basename(wavPath),
            });
            asrQueue.push({ wavPath, startMs, endMs, speakerId: track.speakerId });
            processAsrQueue().catch(() => {});
          } catch (error) {
            logger.error('[音频采集] 保存语音段失败', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        if (!vadErrorLogged) {
          vadErrorLogged = true;
          logger.error('[音频采集] VAD processChunk 异常（后续不再重复）', {
            source: track.source,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
      }
    }
  }
}

/** 给一路采集接进程：stdout 进 VAD，stderr 留诊断，意外退出 3 秒后只重启这一路 */
function attachProcess(track: CaptureTrack, source: 'microphone' | 'system-audio'): boolean {
  let proc: ChildProcess | null;
  try {
    proc = spawnSource(source);
  } catch (error) {
    logger.error('[音频采集] 启动采集进程失败', {
      source,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  if (!proc) return false;
  track.proc = proc;
  pumpPcm(proc.stdout!, track);

  // 捕获 stderr — 权限/设备错误会输出到这里
  let stderrCount = 0;
  proc.stderr!.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg && ++stderrCount <= 3) {
      logger.debug('[音频采集] 采集进程 stderr', { source, message: msg });
    }
  });

  proc.on('error', (err) => {
    logger.error('[音频采集] 采集进程错误', { source, error: err.message });
    if (track.proc === proc) track.proc = null;
  });

  proc.on('exit', (code) => {
    if (track.proc === proc) track.proc = null;
    if (capturing && tracks.includes(track)) {
      logger.warn('[音频采集] 采集进程意外退出，3 秒后自动重启', { code, source });
      setTimeout(() => {
        if (capturing && tracks.includes(track) && !track.proc) {
          logger.info('[音频采集] 正在重启采集进程...', { source });
          attachProcess(track, source);
        }
      }, 3000);
    }
  });

  logger.info('[音频采集] 采集进程已启动 (16kHz mono PCM)', { source });
  return true;
}

async function newTrack(source: CaptureSource, speakerId: number): Promise<CaptureTrack | null> {
  const vad = new VadProcessor();
  if (!(await vad.init())) return null;
  return { source, speakerId, vad, proc: null, stream: null, vadChain: Promise.resolve() };
}

// ============================================================================
// Public API
// ============================================================================

/** 从 FIFO（Tauri Rust 端启动的 rec 写入）读取音频数据 */
function attachFifo(track: CaptureTrack, fifoPath: string): boolean {
  try {
    logger.info('[音频采集] 从 FIFO 读取音频', { fifoPath });
    const stream = fs.createReadStream(fifoPath, { highWaterMark: BLOCK_BYTES * 4 });
    track.stream = stream;
    pumpPcm(stream, track);

    stream.on('error', (err) => {
      logger.error('[音频采集] FIFO 读取错误', { error: err.message });
      track.stream = null;
    });

    stream.on('end', () => {
      if (capturing) {
        logger.warn('[音频采集] FIFO 流结束');
      }
      track.stream = null;
    });

    return true;
  } catch (error) {
    logger.error('[音频采集] 打开 FIFO 失败', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** 按模式决定开哪几路：单路模式不标说话人；会议模式麦克风 = 我、系统音频 = 对方 */
export function planCaptureTracks(
  mode: CaptureMode,
  systemAudioReady: boolean,
): Array<{ source: 'microphone' | 'system-audio'; speakerId: number }> {
  if (mode === 'meeting') {
    // 缺系统音频组件就降级为只录麦克风：外放时麦克风里混着对方，标「我」会错，按不区分记
    return systemAudioReady
      ? [
          { source: 'microphone', speakerId: AUDIO_SPEAKER_ID.ME },
          { source: 'system-audio', speakerId: AUDIO_SPEAKER_ID.OTHERS },
        ]
      : [{ source: 'microphone', speakerId: AUDIO_SPEAKER_ID.UNKNOWN }];
  }
  if (mode === 'system-audio' && systemAudioReady) {
    return [{ source: 'system-audio', speakerId: AUDIO_SPEAKER_ID.UNKNOWN }];
  }
  return [{ source: 'microphone', speakerId: AUDIO_SPEAKER_ID.UNKNOWN }];
}

// 过期录音清扫的统一入口：采集启动/定时器走它，webStartupRetention 的启动期
// 兜底也走它（采集关着的机器否则永远不清理，录音无限堆积）。
export function sweepCapturedAudio(): void {
  const sqlitePath = getSqlitePath();
  if (sqlitePath) ensureAudioTable(sqlitePath);
  sweepAudioRetention({ sqlitePath, audioDir: getAudioDir(), now: Date.now() });
}

export async function startDesktopAudioCapture(fifoPath?: string, mode: CaptureMode = 'microphone'): Promise<void> {
  if (capturing) return;
  requestedMode = mode;

  const useFifo = Boolean(fifoPath && fs.existsSync(fifoPath));
  const systemAudioReady = mode !== 'microphone' && Boolean(findSystemAudioCaptureBinary());
  if (mode !== 'microphone' && !systemAudioReady) {
    logger.warn('[音频采集] system-audio-capture 不可用，回退到麦克风模式', { requestedMode: mode });
  }
  const plan = planCaptureTracks(mode, systemAudioReady);
  const needsMicrophone = plan.some((p) => p.source === 'microphone');

  // Check audio capture tool availability
  // 传了 FIFO 就由 Tauri 端录麦克风，不查本机 ffmpeg/sox（与改造前一致）
  if (needsMicrophone && !fifoPath && !findFfmpegBinary() && !findRecBinary()) {
    logger.warn('[音频采集] ffmpeg/sox 均未安装，跳过音频采集。安装: brew install ffmpeg');
    return;
  }

  // Ensure SQLite table
  const sqlitePath = getSqlitePath();
  if (sqlitePath) {
    ensureAudioTable(sqlitePath);
  }

  // Start capture — prefer FIFO (Rust TCC) over direct spawn；FIFO 只有麦克风一路
  capturing = true;
  const started: CaptureTrack[] = [];
  if (useFifo && fifoPath) {
    const track = await newTrack('fifo', AUDIO_SPEAKER_ID.UNKNOWN);
    if (track && attachFifo(track, fifoPath)) started.push(track);
    logger.info('[音频采集] 使用 Tauri FIFO 模式', { fifoPath });
  } else {
    for (const p of plan) {
      const track = await newTrack(p.source, p.speakerId);
      if (!track) {
        logger.warn('[音频采集] VAD 初始化失败，跳过音频采集');
        break;
      }
      if (attachProcess(track, p.source)) started.push(track);
    }
    logger.info('[音频采集] 使用直接 spawn 模式', { mode, tracks: started.map((t) => t.source) });
  }

  if (started.length === 0) {
    capturing = false;
    return;
  }
  tracks = started;
  captureMode = useFifo ? 'microphone'
    : started.length === 2 ? 'meeting'
      : started[0].source === 'system-audio' ? 'system-audio' : 'microphone';

  // Power management timer
  powerCheckTimer = setInterval(() => {
    const newMode = checkPowerState();
    if (newMode !== powerMode) {
      logger.info('[音频采集] 电源模式切换', { from: powerMode, to: newMode });
      powerMode = newMode;
    }
  }, POWER_CHECK_INTERVAL_MS);

  sweepCapturedAudio();
  audioRetentionTimer = setInterval(sweepCapturedAudio, AUDIO_RETENTION_INTERVAL_MS);

  logger.info('[音频采集] 后台音频采集已启动', { captureMode, requestedMode });
}

export function stopDesktopAudioCapture(): void {
  capturing = false;
  captureMode = 'microphone';
  requestedMode = 'microphone';
  for (const track of tracks) {
    const proc = track.proc;
    if (proc) {
      proc.kill();
      // 采集进程收到 TERM 不退时补 KILL，不留孤儿进程占着麦克风/系统音频
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          logger.warn('[音频采集] 采集进程 TERM 后未退出，强制结束', { source: track.source, pid: proc.pid });
          proc.kill('SIGKILL');
        }
      }, CAPTURE_KILL_GRACE_MS);
    }
    track.stream?.destroy();
  }
  tracks = [];
  if (powerCheckTimer) {
    clearInterval(powerCheckTimer);
    powerCheckTimer = null;
  }
  if (audioRetentionTimer) {
    clearInterval(audioRetentionTimer);
    audioRetentionTimer = null;
  }
  logger.info('[音频采集] 后台音频采集已停止');
}

export function clearAudioRecordings() {
  return clearAllAudioRecordings({ audioDir: getAudioDir(), sqlitePath: getSqlitePath() });
}

export function getAudioCaptureStatus() {
  const prerequisites = getAudioCapturePrerequisites(requestedMode);
  return {
    capturing,
    captureMode,
    requestedMode,
    vadReady: tracks.length > 0,
    soxAvailable: prerequisites.recorder.microphone === 'ready',
    systemAudioAvailable: prerequisites.recorder.systemAudio === 'ready',
    asrEngine: findWhisperBinary() ? 'whisper-cpp' : findQwenAsrModel() ? 'qwen3-asr' : 'none',
    powerMode,
    totalSegments,
    audioDir: getAudioDir(),
    queueLength: asrQueue.length,
    retention: getAudioRetentionStatus(getAudioDir(), getSqlitePath()),
    prerequisites,
    missingPrerequisites: prerequisites.missing,
  };
}
