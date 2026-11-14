import { describe, expect, it } from 'vitest';
import { crossEchoRatio, isCrossEcho, micEchoIds } from '../../../../src/host/services/desktop/audioCrossEcho';

const seg = (id: string, startAtMs: number, endAtMs: number, transcript: string) => ({ id, startAtMs, endAtMs, transcript });

describe('会议模式两路去重', () => {
  it('同一句话两路转写略有出入也算同一句；短句和零散单字不算', () => {
    expect(crossEchoRatio('卡券对账单要加总工单金额这个字段。', '卡券对账单要加总工单金额，这个字段')).toBeGreaterThanOrEqual(0.9);
    expect(crossEchoRatio('对对对', '对对对')).toBe(0); // 不到 6 个相同字不判
    expect(crossEchoRatio('今天先把需求过一遍', '明天下午三点开评审会')).toBe(0);
  });

  it('时间要对得上（容许两路切段错位约 1 秒）', () => {
    const mic = seg('m', 10_000, 14_000, '卡券对账单要加总工单金额这个字段');
    expect(isCrossEcho(mic, seg('o', 10_500, 14_200, '卡券对账单要加总工单金额这个字段'))).toBe(true);
    expect(isCrossEcho(mic, seg('o', 14_800, 18_000, '卡券对账单要加总工单金额这个字段'))).toBe(true);
    expect(isCrossEcho(mic, seg('o', 30_000, 34_000, '卡券对账单要加总工单金额这个字段'))).toBe(false);
  });

  it('只删麦克风里的串录，我自己说的话保留', () => {
    const mic = [
      seg('mine', 0, 3_000, '我这边下周三可以给接口文档'),
      seg('echo', 5_000, 9_000, '那费用承担部门放在领用接口上'),
    ];
    const others = [seg('o1', 5_200, 9_100, '那费用承担部门放在领用接口上吧')];
    expect(micEchoIds(mic, others)).toEqual(['echo']);
  });
});
