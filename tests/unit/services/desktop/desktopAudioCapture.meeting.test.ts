import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_SPEAKER_ID } from '../../../../src/shared/contract/audioCapture';

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../src/host/services/desktop/nativeDesktopService', () => ({
  getNativeDesktopService: () => ({ getStatus: () => ({}) }),
}));
vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => '/tmp/code-agent-test-config',
}));

import { dropMicEchoes } from '../../../../src/host/services/desktop/audioCrossEcho';
import {
  ensureAudioTable,
  persistAudioSegment,
  planCaptureTracks,
} from '../../../../src/host/services/desktop/desktopAudioCapture';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-meeting-audio-'));
  dirs.push(dir);
  const db = path.join(dir, 'desktop.sqlite');
  execFileSync('sqlite3', [db, 'SELECT 1;']);
  ensureAudioTable(db);
  return db;
}

function put(db: string, id: string, startAtMs: number, endAtMs: number, transcript: string, speakerId: number): void {
  expect(persistAudioSegment(db, {
    id, startAtMs, endAtMs, durationMs: endAtMs - startAtMs, wavPath: `/tmp/${id}.wav`,
    transcript, speakerId, asrEngine: 'whisper-cpp', asrDurationMs: 10,
  }, 1)).toBe(true);
}

function rows(db: string): Array<{ id: string; speaker_id: number }> {
  const raw = execFileSync('sqlite3', ['-json', db, 'SELECT id, speaker_id FROM audio_segments ORDER BY id;'], { encoding: 'utf-8' }).trim();
  return raw ? JSON.parse(raw) : [];
}

describe('会议模式：两路同录、按声道分我 / 对方', () => {
  it('会议模式开两路：麦克风 = 我、系统音频 = 对方；单路模式不标说话人', () => {
    expect(planCaptureTracks('meeting', true)).toEqual([
      { source: 'microphone', speakerId: AUDIO_SPEAKER_ID.ME },
      { source: 'system-audio', speakerId: AUDIO_SPEAKER_ID.OTHERS },
    ]);
    expect(planCaptureTracks('microphone', true)).toEqual([{ source: 'microphone', speakerId: AUDIO_SPEAKER_ID.UNKNOWN }]);
    expect(planCaptureTracks('system-audio', true)).toEqual([{ source: 'system-audio', speakerId: AUDIO_SPEAKER_ID.UNKNOWN }]);
  });

  it('缺系统音频组件：会议模式降级为只录麦克风，不标成「我」（外放时麦克风里混着对方）', () => {
    expect(planCaptureTracks('meeting', false)).toEqual([{ source: 'microphone', speakerId: AUDIO_SPEAKER_ID.UNKNOWN }]);
    expect(planCaptureTracks('system-audio', false)).toEqual([{ source: 'microphone', speakerId: AUDIO_SPEAKER_ID.UNKNOWN }]);
  });

  it('写库带 speaker_id，读出来就是我 / 对方', () => {
    const db = tempDb();
    put(db, 'audio-1000-s1', 1_000, 3_000, '我这边下周三可以给接口文档', AUDIO_SPEAKER_ID.ME);
    put(db, 'audio-1000-s2', 1_000, 3_500, '好的那就按这个时间来', AUDIO_SPEAKER_ID.OTHERS);
    expect(rows(db)).toEqual([
      { id: 'audio-1000-s1', speaker_id: AUDIO_SPEAKER_ID.ME },
      { id: 'audio-1000-s2', speaker_id: AUDIO_SPEAKER_ID.OTHERS },
    ]);
  });

  it('外放串录：同一句两路都有，删麦克风那条；我自己说的和单路模式的段不动', () => {
    const db = tempDb();
    put(db, 'audio-0-s1', 0, 3_000, '我这边下周三可以给接口文档', AUDIO_SPEAKER_ID.ME);
    put(db, 'audio-5000-s1', 5_000, 9_000, '那费用承担部门放在领用接口上', AUDIO_SPEAKER_ID.ME);
    put(db, 'audio-5200-s2', 5_200, 9_100, '那费用承担部门放在领用接口上吧', AUDIO_SPEAKER_ID.OTHERS);
    put(db, 'audio-5100', 5_100, 9_000, '那费用承担部门放在领用接口上', AUDIO_SPEAKER_ID.UNKNOWN);

    expect(dropMicEchoes(db, 5_200, 9_100)).toBe(1);
    expect(rows(db).map((r) => r.id)).toEqual(['audio-0-s1', 'audio-5100', 'audio-5200-s2']);
    expect(dropMicEchoes(db, 5_200, 9_100)).toBe(0); // 幂等
  });
});
