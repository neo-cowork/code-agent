import { describe, expect, it } from 'vitest';
import { AudioStreamClock } from '../../../../src/host/services/desktop/audioStreamClock';

const SR = 16000;

describe('音频流时钟：段落时间按样本数推算', () => {
  it('处理严重滞后时（now 已过去很久），时间仍由样本数决定，不随处理延迟漂移', () => {
    let now = 10_000;
    const clock = new AudioStreamClock(SR, () => now);
    clock.receive(1024); // 首包 512 样本 = 32ms，到达于 10_000 → 原点 9_968
    now = 60_000; // 转写占满 CPU，处理拖了 50 秒
    expect(clock.advance(512)).toBe(10_000);
    expect(clock.advance(SR * 9)).toBe(19_000); // 再处理 9 秒的音频 → 9 秒后，而不是 now
    clock.receive(1024); // 后续包不改原点
    expect(clock.advance(0)).toBe(19_000);
  });

  it('省电暂停丢掉的样本也计入时间，恢复后不往回漂', () => {
    let now = 0;
    const clock = new AudioStreamClock(SR, () => now);
    clock.receive(2);
    clock.advance(SR * 2); // 处理了 2 秒
    clock.advance(SR * 5); // 暂停期间丢了 5 秒
    now = 999_999;
    expect(clock.advance(SR)).toBe(8_000);
  });
});
