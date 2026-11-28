// ============================================================================
// 录麦克风用哪个程序的唯一查找入口
//
// 之前「设置里显示能不能录」和「真开始录音」各写一份候选路径和 PATH 查找，
// 两边一改就对不上。现在前置检查（audioCapturePrerequisites）和真实录音
// （desktopAudioCapture）都调这里，状态说能录，录音用的就是同一个程序。
//
// Rust 壳里还留着一份只查 ffmpeg 的候选路径（src-tauri/src/native_desktop.rs
// 的 find_ffmpeg_binary）：那条路在 Tauri 进程里起录音、不经过这里；找不到时它
// 返回稳定码 recorder_missing（@shared/contract/audioCapture），不带安装命令。
// ============================================================================

import fs from 'fs';
import { whichOnPath } from '../media/whisperBinary';

// ffmpeg 走 AVFoundation 采集（sox CoreAudio 在 Tauri 子进程里拿不到麦克风权限），有它就用它
const FFMPEG_PATHS = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
// sox 的 rec：没有 ffmpeg 时的回落
const REC_PATHS = ['/opt/homebrew/bin/rec', '/usr/local/bin/rec', '/usr/bin/rec'];

function findProgram(name: string, candidates: string[]): string | null {
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  const resolved = whichOnPath(name);
  return resolved && fs.existsSync(resolved) ? resolved : null;
}

/** 录麦克风用的程序：先常见安装目录、再 PATH；有 ffmpeg 用 ffmpeg，没有才用 rec，都没有返回 null */
export function findMicrophoneRecorder(): { kind: 'ffmpeg' | 'rec'; path: string } | null {
  const ffmpeg = findProgram('ffmpeg', FFMPEG_PATHS);
  if (ffmpeg) return { kind: 'ffmpeg', path: ffmpeg };
  const rec = findProgram('rec', REC_PATHS);
  return rec ? { kind: 'rec', path: rec } : null;
}
