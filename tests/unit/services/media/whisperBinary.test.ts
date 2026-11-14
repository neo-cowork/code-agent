import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { findWhisperBinary, hasWhisperModel } from '../../../../src/host/services/media/whisperBinary';

const exists = (present: string[]) => (p: string) => present.includes(p);
const noWhich = () => null;

describe('本地 whisper 程序查找', () => {
  it('新版 Homebrew 只装出 whisper-cli 也认得', () => {
    expect(findWhisperBinary(exists(['/opt/homebrew/bin/whisper-cli']), noWhich)).toBe('/opt/homebrew/bin/whisper-cli');
  });

  it('旧版只有 whisper-cpp 照样认', () => {
    expect(findWhisperBinary(exists(['/usr/local/bin/whisper-cpp']), noWhich)).toBe('/usr/local/bin/whisper-cpp');
  });

  it('两个都没有 → null；PATH 上能找到也算', () => {
    expect(findWhisperBinary(exists([]), noWhich)).toBeNull();
    const which = (name: string) => (name === 'whisper-cli' ? '/opt/custom/bin/whisper-cli' : null);
    expect(findWhisperBinary(exists(['/opt/custom/bin/whisper-cli']), which)).toBe('/opt/custom/bin/whisper-cli');
  });
});

describe('whisper 模型', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('~/.cache/whisper 下有 ggml-*.bin 才算有模型', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-whisper-home-'));
    dirs.push(home);
    expect(hasWhisperModel(home)).toBe(false);
    fs.mkdirSync(path.join(home, '.cache', 'whisper'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cache', 'whisper', 'readme.txt'), '');
    expect(hasWhisperModel(home)).toBe(false);
    fs.writeFileSync(path.join(home, '.cache', 'whisper', 'ggml-base.bin'), '');
    expect(hasWhisperModel(home)).toBe(true);
  });
});
