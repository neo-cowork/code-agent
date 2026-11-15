import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// N-MEETING-DUALTRACK-FU1：一路音频的数据包必须逐个过 VAD。并发进 session.run 会共用旧的
// 隐藏状态，真机上段落被错合/错切、时间偏出好几秒。
const vad = vi.hoisted(() => ({ inflight: 0, maxInflight: 0, runs: 0, inputs: [] as Float32Array[], prob: 0, configDir: '/tmp/code-agent-test-config' }));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../src/host/services/desktop/audioVadRuntime', () => ({
  isOrtTensor: vi.fn(() => true),
  loadVadRuntime: () => ({
    ok: true,
    modelPath: '/fake/silero.onnx',
    ort: {
      Tensor: class { constructor(public type: string, public data: unknown) {} },
      InferenceSession: {
        create: async () => ({
          run: async (feeds: { input: { data: Float32Array } }) => {
            vad.inputs.push(feeds.input.data);
            vad.inflight++;
            vad.maxInflight = Math.max(vad.maxInflight, vad.inflight);
            await new Promise((r) => setTimeout(r, 2));
            vad.inflight--;
            vad.runs++;
            return { output: { data: new Float32Array([vad.prob]) }, stateN: {} };
          },
        }),
      },
    },
  }),
}));
vi.mock('../../../../src/host/services/desktop/nativeDesktopService', () => ({
  getNativeDesktopService: () => ({ getStatus: () => ({}) }),
}));
vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => vad.configDir,
}));

describe('音频采集：一路数据包逐个过 VAD', () => {
  let dir = '';
  afterEach(async () => {
    const { stopDesktopAudioCapture } = await import('../../../../src/host/services/desktop/desktopAudioCapture');
    stopDesktopAudioCapture();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('数据包一次到一大批时，VAD 推理也不并发', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-serial-vad-'));
    const pcm = path.join(dir, 'in.pcm');
    fs.writeFileSync(pcm, Buffer.alloc(1024 * 40)); // 40 块，读流会一次推出好几包
    const { startDesktopAudioCapture } = await import('../../../../src/host/services/desktop/desktopAudioCapture');

    await startDesktopAudioCapture(pcm, 'microphone');
    await vi.waitFor(() => expect(vad.runs).toBe(40), { timeout: 3000 });

    expect(vad.maxInflight).toBe(1);
  });

  it('送进模型的每块前面拼着上一块的最后 64 个样本（Silero v5 16kHz 用法）', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-vad-ctx-'));
    const pcm = path.join(dir, 'in.pcm');
    const samples = new Int16Array(512 * 3).map((_, i) => i); // 样本值 = 序号，便于对位
    fs.writeFileSync(pcm, Buffer.from(samples.buffer));
    vad.inputs = [];
    const { startDesktopAudioCapture } = await import('../../../../src/host/services/desktop/desktopAudioCapture');

    await startDesktopAudioCapture(pcm, 'microphone');
    await vi.waitFor(() => expect(vad.inputs.length).toBe(3), { timeout: 3000 });

    expect(vad.inputs.map((x) => x.length)).toEqual([576, 576, 576]);
    expect(Array.from(vad.inputs[0].slice(0, 64))).toEqual(new Array(64).fill(0)); // 首块前补零
    expect(Math.round(vad.inputs[1][0] * 32768)).toBe(512 - 64); // 第二块开头 = 第一块倒数第 64 个样本
    expect(Math.round(vad.inputs[1][64] * 32768)).toBe(512);
  });
});

describe('停止录音时收尾正在说的那段（N-MEETING-SESSION）', () => {
  it('说到一半就停：这段照样存成录音交去转写，不随停止丢掉', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-flush-'));
    vad.configDir = dir;
    vad.prob = 0.9; // 一直在说话，没有 2 秒静音收段
    vad.runs = 0;
    const pcm = path.join(dir, 'in.pcm');
    fs.writeFileSync(pcm, Buffer.alloc(1024 * 40)); // 40 块 ≈ 1.3 秒
    const { startDesktopAudioCapture, stopDesktopAudioCapture } = await import('../../../../src/host/services/desktop/desktopAudioCapture');

    await startDesktopAudioCapture(pcm, 'microphone');
    await vi.waitFor(() => expect(vad.runs).toBe(40), { timeout: 3000 });
    stopDesktopAudioCapture();

    const audioDir = path.join(dir, 'native-desktop', 'audio');
    await vi.waitFor(() => {
      const wavs = fs.readdirSync(audioDir, { recursive: true }).filter((f) => String(f).endsWith('.wav'));
      expect(wavs).toHaveLength(1);
    }, { timeout: 3000 });
    vad.prob = 0;
    vad.configDir = '/tmp/code-agent-test-config';
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('收尾只交够最短时长的段，太短的（误触）不交', async () => {
    const { VadStateMachine } = await import('../../../../src/host/services/desktop/desktopAudioCapture');
    const long = new VadStateMachine();
    for (let i = 0; i < 20; i++) long.processChunk(new Int16Array(512).fill(1), 0.9); // 640ms
    expect(long.flush()).toHaveLength(1);
    expect(long.flush()).toHaveLength(0); // 交过就清空

    const short = new VadStateMachine();
    for (let i = 0; i < 5; i++) short.processChunk(new Int16Array(512).fill(1), 0.9); // 160ms < 500ms
    expect(short.flush()).toHaveLength(0);
  });
});

describe('VAD 开口补白', () => {
  it('段落开头带上开口前 200ms 的样本，跨了好几块也不丢', async () => {
    const { VadStateMachine } = await import('../../../../src/host/services/desktop/desktopAudioCapture');
    const sm = new VadStateMachine();
    let t = 0;
    const block = () => new Int16Array(512).map(() => t++);
    for (let i = 0; i < 20; i++) sm.processChunk(block(), 0); // 静音 20 块
    const onsetSample = t;
    for (let i = 0; i < 20; i++) sm.processChunk(block(), 0.9); // 说话 640ms
    const segments: Int16Array[] = [];
    for (let i = 0; i < 70 && segments.length === 0; i++) segments.push(...sm.processChunk(block(), 0)); // 静音 2s 收段

    expect(segments).toHaveLength(1);
    expect(segments[0][0]).toBe(onsetSample - 3200); // 补满 200ms（3200 样本），不是只补上一块的 512
  });

  it('长句超过 15 秒切分时，切在最安静那块的开头，不被段首补白带偏', async () => {
    const { VadStateMachine } = await import('../../../../src/host/services/desktop/desktopAudioCapture');
    const sm = new VadStateMachine();
    const block = (v: number) => new Int16Array(512).fill(v);
    for (let i = 0; i < 20; i++) sm.processChunk(block(0), 0); // 静音，攒满 200ms 补白
    const quiet = 400; // 后半段里概率最低的一块（仍算说话）
    const segments: Int16Array[] = [];
    for (let i = 0; i < 480 && segments.length === 0; i++) {
      segments.push(...sm.processChunk(block(i === quiet ? 7 : 1), i === quiet ? 0.4 : 0.9));
    }

    expect(segments).toHaveLength(1);
    expect(segments[0].length).toBe(3200 + quiet * 512); // 补白 + 最安静那块之前的说话
    expect(segments[0][segments[0].length - 1]).toBe(1); // 最安静那块（值 7）留给下一段开头
  });
});
