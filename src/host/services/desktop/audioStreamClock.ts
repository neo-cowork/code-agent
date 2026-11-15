// ============================================================================
// 一路音频流的时钟（N-MEETING-DUALTRACK-FU1）
//
// 段落时间不能用「VAD 切出段落那一刻」的 Date.now()：转写把 CPU 占满时语音检测处理
// 跟不上实时，段落时间会整体后移（11-14 真机：第二句晚约 9 秒）。改为按样本数推算：
// 首包到达时刻往前推一包时长定原点，此后每处理一块样本时间就前进这块的时长。
// ============================================================================

export class AudioStreamClock {
  private originMs: number | null = null;
  private samples = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 收到一包 16-bit 单声道数据：首包定原点（到达时刻减去这包的时长） */
  receive(bytes: number): void {
    if (this.originMs === null) {
      this.originMs = this.now() - (bytes / 2 / this.sampleRate) * 1000;
    }
  }

  /** 按顺序消费掉一批样本（含省电暂停时被丢弃的），返回消费完这批时对应的音频时间 */
  advance(samples: number): number {
    this.samples += samples;
    return Math.round((this.originMs ?? this.now()) + (this.samples / this.sampleRate) * 1000);
  }
}
