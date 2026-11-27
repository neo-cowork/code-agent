import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 录音程序的候选路径、whisper 模型目录在 src/host 里各只许有一份定义。
// 多一份，「设置里说就绪」和「真录音/真转写用到的」就可能又对不上。

const HOST_ROOT = path.join(process.cwd(), 'src/host');
const RECORDER_MODULE = 'src/host/services/desktop/microphoneRecorder.ts';
const WHISPER_MODULE = 'src/host/services/media/whisperBinary.ts';
const RUST_SHELL = 'src-tauri/src/native_desktop.rs';

function collectTsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectTsFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function hostFilesMatching(pattern: RegExp): string[] {
  return collectTsFiles(HOST_ROOT)
    .filter((file) => pattern.test(fs.readFileSync(file, 'utf-8')))
    .map((file) => path.relative(process.cwd(), file).replaceAll('\\', '/'))
    .sort();
}

function quotedPaths(source: string, program: string): string[] {
  return [...source.matchAll(new RegExp(`['"](/[\\w/.-]*/bin/${program})['"]`, 'g'))].map((m) => m[1]).sort();
}

describe('录音程序与 whisper 模型只有一个查找入口', () => {
  it('FFMPEG_PATHS / REC_PATHS 只在 microphoneRecorder 里定义', () => {
    expect(hostFilesMatching(/\b(?:const|let|var)\s+FFMPEG_PATHS\b/)).toEqual([RECORDER_MODULE]);
    expect(hostFilesMatching(/\b(?:const|let|var)\s+REC_PATHS\b/)).toEqual([RECORDER_MODULE]);
  });

  it('ffmpeg / rec 的安装路径字面量不在别的文件里再写一遍（换个常量名也不行）', () => {
    expect(hostFilesMatching(/['"`]\/[\w/.-]*\/bin\/(?:ffmpeg|rec)['"`]/)).toEqual([RECORDER_MODULE]);
  });

  it('桌面录音不再自带模型目录：WHISPER_MODEL_DIR 没有定义，.cache/whisper 的拼接只在 whisperBinary 和本机转写工具里', () => {
    expect(hostFilesMatching(/\bWHISPER_MODEL_DIR\b/)).toEqual([]);
    expect(hostFilesMatching(/'\.cache',\s*'whisper'/)).toEqual([
      WHISPER_MODULE,
      // 存量：local_speech_to_text 工具自己的模型目录（不认 CODE_AGENT_HOME），不在本单范围
      'src/host/services/media/whisperCppTranscriber.ts',
    ]);
  });

  it('Rust 壳留着的那份 ffmpeg 候选路径和 TS 一致，找不到时报稳定码而不是安装命令', () => {
    const rust = fs.readFileSync(path.join(process.cwd(), RUST_SHELL), 'utf-8');
    const recorder = fs.readFileSync(path.join(process.cwd(), RECORDER_MODULE), 'utf-8');
    const contract = fs.readFileSync(path.join(process.cwd(), 'src/shared/contract/audioCapture.ts'), 'utf-8');

    expect(quotedPaths(rust, 'ffmpeg')).toEqual(quotedPaths(recorder, 'ffmpeg'));
    expect(rust).not.toMatch(/brew install/);
    expect(rust).toContain('find_ffmpeg_binary().ok_or("recorder_missing")?');
    // 这个码就是设置页已经会翻译的那个（renderer i18n 的 recorderMissing）
    expect(contract).toContain("| 'recorder_missing'");
  });
});
