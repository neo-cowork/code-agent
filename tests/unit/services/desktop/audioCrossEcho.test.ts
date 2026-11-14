import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_SPEAKER_ID } from '../../../../src/shared/contract/audioCapture';

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { dropMicEchoes } from '../../../../src/host/services/desktop/audioCrossEcho';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** 一路麦克风段 + 一路系统音频段写进真 sqlite，跑一次去重，返回麦克风段是否被删 */
function micDropped(mic: [number, number, string], others: [number, number, string]): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-cross-echo-'));
  dirs.push(dir);
  const db = path.join(dir, 'a.sqlite');
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  execFileSync('sqlite3', [db, `CREATE TABLE audio_segments (id TEXT PRIMARY KEY, start_at_ms INTEGER, end_at_ms INTEGER, transcript TEXT, speaker_id INTEGER);
INSERT INTO audio_segments VALUES ('mic', ${mic[0]}, ${mic[1]}, ${q(mic[2])}, ${AUDIO_SPEAKER_ID.ME});
INSERT INTO audio_segments VALUES ('oth', ${others[0]}, ${others[1]}, ${q(others[2])}, ${AUDIO_SPEAKER_ID.OTHERS});`]);
  dropMicEchoes(db, Math.min(mic[0], others[0]), Math.max(mic[1], others[1]));
  const left = execFileSync('sqlite3', [db, 'SELECT id FROM audio_segments ORDER BY id;'], { encoding: 'utf-8' }).trim().split('\n');
  expect(left).toContain('oth'); // 系统音频那条永远不删
  return !left.includes('mic');
}

describe('会议模式两路去重的判定', () => {
  it('同一句话两路转写略有出入（标点、语气词）也算串录', () => {
    expect(micDropped([10_000, 14_000, '卡券对账单要加总工单金额这个字段。'], [10_200, 14_100, '卡券对账单要加总工单金额，这个字段吧'])).toBe(true);
  });

  it('不到 6 个相同字的短句不判重（「对对对」两边都会说）', () => {
    expect(micDropped([10_000, 11_000, '对对对'], [10_100, 11_000, '对对对'])).toBe(false);
  });

  it('内容不同不删：我自己说的话保留', () => {
    expect(micDropped([10_000, 14_000, '我这边下周三可以给接口文档'], [10_200, 14_100, '那费用承担部门放在领用接口上'])).toBe(false);
  });

  it('时间要对得上：两路切段错位 1 秒内算同一句，隔得远不算', () => {
    expect(micDropped([10_000, 14_000, '卡券对账单要加总工单金额这个字段'], [14_800, 18_000, '卡券对账单要加总工单金额这个字段'])).toBe(true);
    expect(micDropped([10_000, 14_000, '卡券对账单要加总工单金额这个字段'], [30_000, 34_000, '卡券对账单要加总工单金额这个字段'])).toBe(false);
  });
});
