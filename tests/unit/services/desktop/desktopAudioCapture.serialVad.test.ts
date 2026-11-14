import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// N-MEETING-DUALTRACK-FU1：一路音频的数据包必须逐个过 VAD。并发进 session.run 会共用旧的
// 隐藏状态，真机上段落被错合/错切、时间偏出好几秒。
const vad = vi.hoisted(() => ({ inflight: 0, maxInflight: 0, runs: 0 }));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../src/host/services/desktop/audioVadRuntime', () => ({
  isOrtTensor: vi.fn(() => false),
  loadVadRuntime: () => ({
    ok: true,
    modelPath: '/fake/silero.onnx',
    ort: {
      Tensor: class {},
      InferenceSession: {
        create: async () => ({
          run: async () => {
            vad.inflight++;
            vad.maxInflight = Math.max(vad.maxInflight, vad.inflight);
            await new Promise((r) => setTimeout(r, 2));
            vad.inflight--;
            vad.runs++;
            return {};
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
  getUserConfigDir: () => '/tmp/code-agent-test-config',
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
});
