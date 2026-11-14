// ============================================================================
// 语音检测状态机：按 Silero 每块的说话概率切出语音段（ported from meeting-cli VadEngine）
// 从 desktopAudioCapture.ts 拆出（该文件超 1000 行上限，N-MEETING-SESSION）
// ============================================================================

export const SAMPLE_RATE = 16000;
export const BLOCK_SIZE = 512; // 512 samples = 32ms at 16kHz

// VAD thresholds (Silero v5, matching meeting-cli's hysteresis)
const VAD_ONSET = 0.5; // start speech: high threshold
const VAD_OFFSET = 0.35; // end speech: lower threshold
const MIN_SPEECH_MS = 500; // minimum speech duration to keep
const MIN_SILENCE_MS = 2000; // 2s silence to finalize segment
const SPEECH_PAD_MS = 200; // pad speech boundaries
const MAX_SPEECH_S = 15; // max segment duration, then smart-split

export class VadStateMachine {
  private speechActive = false;
  private speechBuffer: number[] = [];
  private speechSamples = 0;
  private silenceSamples = 0;
  private probHistory: number[] = [];
  private pendingPad: number[] = [];
  /** speechBuffer 开头那段补白的样本数：probHistory[0] 对应的块从这里开始 */
  private leadSamples = 0;

  private readonly onset: number;
  private readonly offset: number;
  private readonly minSpeechSamples: number;
  private readonly minSilenceSamples: number;
  private readonly speechPadSamples: number;
  private readonly maxSpeechSamples: number;

  constructor(onset = VAD_ONSET, offset = VAD_OFFSET) {
    this.onset = onset;
    this.offset = offset;
    this.minSpeechSamples = Math.floor(MIN_SPEECH_MS * SAMPLE_RATE / 1000);
    this.minSilenceSamples = Math.floor(MIN_SILENCE_MS * SAMPLE_RATE / 1000);
    this.speechPadSamples = Math.floor(SPEECH_PAD_MS * SAMPLE_RATE / 1000);
    this.maxSpeechSamples = Math.floor(MAX_SPEECH_S * SAMPLE_RATE);
  }

  processChunk(pcmInt16: Int16Array, prob: number): Int16Array[] {
    const completed: Int16Array[] = [];
    const chunkLen = pcmInt16.length;

    // Hysteresis: use onset to START speech, offset to END speech
    const isSpeech = this.speechActive ? prob >= this.offset : prob >= this.onset;

    if (isSpeech) {
      if (!this.speechActive) {
        // Speech onset
        this.speechActive = true;
        this.speechBuffer = [...this.pendingPad];
        this.leadSamples = this.pendingPad.length;
        this.speechSamples = this.speechBuffer.length;
        this.silenceSamples = 0;
        this.probHistory = [];
      }

      for (let i = 0; i < pcmInt16.length; i++) {
        this.speechBuffer.push(pcmInt16[i]);
      }
      this.speechSamples += chunkLen;
      this.silenceSamples = 0;
      this.probHistory.push(prob);

      // Smart max-duration split
      if (this.speechSamples >= this.maxSpeechSamples) {
        const segment = this.smartSplit();
        if (segment) completed.push(segment);
      }
    } else {
      if (this.speechActive) {
        for (let i = 0; i < pcmInt16.length; i++) {
          this.speechBuffer.push(pcmInt16[i]);
        }
        this.silenceSamples += chunkLen;
        this.probHistory.push(prob);

        if (this.silenceSamples >= this.minSilenceSamples) {
          // Silence long enough → finalize segment
          if (this.speechSamples >= this.minSpeechSamples) {
            completed.push(new Int16Array(this.speechBuffer));
          }
          this.speechActive = false;
          this.speechBuffer = [];
          this.speechSamples = 0;
          this.silenceSamples = 0;
          this.probHistory = [];
        }
        // Short gaps (breathing) → keep buffering
      }
    }

    // 滚动保留最近 speechPadSamples 个样本，开口时补在段落前面。原来只取本块的尾巴，
    // 一块只有 512 样本，实际只补 32ms，每句开头被吃字（N-MEETING-DUALTRACK-FU2）
    this.pendingPad = this.pendingPad.concat(Array.from(pcmInt16)).slice(-this.speechPadSamples);

    return completed;
  }

  private smartSplit(): Int16Array | null {
    if (this.probHistory.length === 0) {
      const seg = new Int16Array(this.speechBuffer);
      this.speechBuffer = [];
      this.speechSamples = 0;
      this.probHistory = [];
      return seg;
    }

    // Find lowest-prob chunk in second half
    const half = Math.floor(this.probHistory.length / 2);
    const secondHalf = this.probHistory.slice(half);
    let minIdx = half;
    let minVal = secondHalf[0];
    for (let i = 1; i < secondHalf.length; i++) {
      if (secondHalf[i] < minVal) {
        minVal = secondHalf[i];
        minIdx = half + i;
      }
    }

    // 切在最安静那块的开头：要跳过段首补白，否则切点提前补白那么长、切进字中间
    const splitSample = this.leadSamples + minIdx * BLOCK_SIZE;
    if (splitSample <= 0 || splitSample >= this.speechBuffer.length) {
      const seg = new Int16Array(this.speechBuffer);
      this.speechBuffer = [];
      this.speechSamples = 0;
      this.probHistory = [];
      return seg;
    }

    const firstPart = new Int16Array(this.speechBuffer.slice(0, splitSample));
    this.speechBuffer = this.speechBuffer.slice(splitSample);
    this.speechSamples = this.speechBuffer.length;
    this.probHistory = this.probHistory.slice(minIdx);
    this.leadSamples = 0; // 剩下的从最安静那块开头起，不再带补白
    return firstPart;
  }

  /** 录音停止时收尾：正在说的那段（够最短时长）作为最后一段交出去，不随停止丢掉 */
  flush(): Int16Array[] {
    const out = this.speechActive && this.speechSamples >= this.minSpeechSamples ? [new Int16Array(this.speechBuffer)] : [];
    this.speechActive = false;
    this.speechBuffer = [];
    this.speechSamples = 0;
    this.silenceSamples = 0;
    this.probHistory = [];
    this.leadSamples = 0;
    return out;
  }

  get isSpeaking(): boolean {
    return this.speechActive;
  }
}
