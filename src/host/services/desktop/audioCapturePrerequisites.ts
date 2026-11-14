import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  AudioCaptureMode,
  AudioCaptureMissingPrerequisiteCode,
  AudioCapturePrerequisites,
  AudioCaptureVoiceDetectionState,
} from '@shared/contract/audioCapture';
import { getUserConfigDir } from '../../config/configPaths';
import { createLogger } from '../infra/logger';
import { loadVadRuntime, type VadRuntimeLoadResult } from './audioVadRuntime';

const logger = createLogger('AudioCapturePrerequisites');

const FFMPEG_PATHS = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
const REC_PATHS = ['/opt/homebrew/bin/rec', '/usr/local/bin/rec', '/usr/bin/rec'];
const SYSTEM_AUDIO_CAPTURE_NAME = 'system-audio-capture';
const WHISPER_PATHS = ['/opt/homebrew/bin/whisper-cpp', '/usr/local/bin/whisper-cpp'];

function isCommandOnPath(command: string): boolean {
  try {
    const resolved = execFileSync('which', [command], { encoding: 'utf-8' }).trim();
    return Boolean(resolved) && fs.existsSync(resolved);
  } catch {
    return false;
  }
}

function hasMicrophoneRecorder(): boolean {
  for (const candidate of [...FFMPEG_PATHS, ...REC_PATHS]) {
    if (fs.existsSync(candidate)) return true;
  }
  return isCommandOnPath('ffmpeg') || isCommandOnPath('rec');
}

function hasSystemAudioRecorder(moduleDir = __dirname): boolean {
  const scriptDir = path.join(moduleDir, '..', '..', '..', 'scripts');
  const candidates = [
    path.join(scriptDir, SYSTEM_AUDIO_CAPTURE_NAME),
    path.join(moduleDir, '..', '..', 'scripts', SYSTEM_AUDIO_CAPTURE_NAME),
    path.join(getUserConfigDir(), 'bin', SYSTEM_AUDIO_CAPTURE_NAME),
  ];
  return candidates.some((candidate) => fs.existsSync(candidate));
}

function hasWhisperEngine(): boolean {
  return WHISPER_PATHS.some((candidate) => fs.existsSync(candidate)) || isCommandOnPath('whisper-cpp');
}

function hasQwenEngine(homeDir: string): boolean {
  const qwenPaths = [
    path.join(homeDir, 'Library/Application Support/net.bytenote.asro/models/qwen3-asr-0.6b'),
    path.join(homeDir, '.cache/huggingface/hub/models--Qwen--Qwen3-ASR-0.6B/snapshots'),
  ];
  for (const candidate of qwenPaths) {
    if (!fs.existsSync(candidate)) continue;
    if (candidate.includes('snapshots')) {
      try {
        if (fs.readdirSync(candidate).some((file) => !file.startsWith('.'))) return true;
      } catch {
        // ignore unreadable snapshot dir
      }
    }
    if (fs.existsSync(path.join(candidate, 'model.safetensors'))) return true;
  }
  return false;
}

function detectVoiceDetectionState(moduleDir = __dirname): AudioCaptureVoiceDetectionState {
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return 'unsupported';
  }
  let runtime: VadRuntimeLoadResult;
  try {
    runtime = loadVadRuntime(moduleDir);
  } catch (error) {
    logger.warn('[音频采集] 语音检测运行组件加载抛错，按缺失处理', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'missing';
  }
  if (runtime.ok) return 'ready';
  if (
    runtime.reason === 'missing-runtime'
    && ((process.platform === 'darwin' && process.arch === 'arm64')
      || (process.platform === 'linux' && process.arch === 'x64'))
  ) {
    return 'downloadable';
  }
  return 'missing';
}

export function getAudioCapturePrerequisites(
  activeMode: AudioCaptureMode = 'microphone',
): AudioCapturePrerequisites {
  const homeDir = process.env.CODE_AGENT_HOME || os.homedir();
  const microphoneReady = hasMicrophoneRecorder();
  const systemAudioReady = hasSystemAudioRecorder();
  const transcriptionReady = hasWhisperEngine() || hasQwenEngine(homeDir);
  const voiceDetection = detectVoiceDetectionState();

  const missing: AudioCaptureMissingPrerequisiteCode[] = [];
  // 会议模式缺系统音频组件时降级为只录麦克风，和系统音频模式同一个提示码
  if (activeMode === 'system-audio' || activeMode === 'meeting') {
    if (!systemAudioReady && !microphoneReady) {
      missing.push('recorder_missing');
    } else if (!systemAudioReady) {
      missing.push('system_audio_helper_missing');
    }
  } else if (!microphoneReady) {
    missing.push('recorder_missing');
  }

  if (!transcriptionReady) {
    missing.push('transcription_engine_missing');
  }

  if (voiceDetection === 'unsupported') {
    missing.push('voice_detection_unsupported');
  } else if (voiceDetection !== 'ready') {
    missing.push('voice_detection_missing');
  }

  return {
    recorder: {
      microphone: microphoneReady ? 'ready' : 'missing',
      systemAudio: systemAudioReady ? 'ready' : 'missing',
    },
    transcriptionEngine: transcriptionReady ? 'ready' : 'missing',
    voiceDetection,
    missing,
  };
}
