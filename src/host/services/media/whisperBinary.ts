// ============================================================================
// 本地 whisper 转写程序与模型的唯一查找入口（N-FIX-WHISPER-CLI-BINARY-NAME）
//
// Homebrew 的 whisper-cpp 新版装出来的命令叫 whisper-cli，旧版叫 whisper-cpp。
// 之前桌面录音、前置检查、local_speech_to_text 三处各写死 whisper-cpp，
// 装了新版的机器上全都判成「没有转写引擎」。
// ============================================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const WHISPER_BINARY_NAMES = ['whisper-cli', 'whisper-cpp'];
const WHISPER_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

function whichOnPath(name: string): string | null {
  try {
    return execFileSync('which', [name], { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

/** 找本机 whisper 命令：先查 Homebrew 常见目录，再查 PATH；两个名字都认 */
export function findWhisperBinary(
  exists: (p: string) => boolean = fs.existsSync,
  which: (name: string) => string | null = whichOnPath,
): string | null {
  for (const dir of WHISPER_BIN_DIRS) {
    for (const name of WHISPER_BINARY_NAMES) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  for (const name of WHISPER_BINARY_NAMES) {
    const resolved = which(name);
    if (resolved && exists(resolved)) return resolved;
  }
  return null;
}

function whisperModelDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.cache', 'whisper');
}

/** 模型目录里有没有任何 ggml-*.bin（有程序没模型同样转不了字） */
export function hasWhisperModel(homeDir: string = os.homedir()): boolean {
  try {
    return fs.readdirSync(whisperModelDir(homeDir)).some((f) => f.startsWith('ggml-') && f.endsWith('.bin'));
  } catch {
    return false;
  }
}

/**
 * whisper 的语言参数。指定中文时它会随机输出繁体（11-14 真机：同一句话系统音频一路简体、
 * 麦克风一路繁体），给一句简体提示让输出稳定在简体——国内用户要的是简体，两路去重也才对得上字。
 */
export function whisperLanguageArgs(language: string): string[] {
  return language === 'zh' ? ['-l', 'zh', '--prompt', '以下是普通话的句子。'] : ['-l', language];
}
