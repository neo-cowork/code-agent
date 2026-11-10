// ============================================================================
// ConcurrencyLimiter Tests
// ============================================================================

import { afterEach, describe, it, expect, vi } from 'vitest';
import { streamText, generateText } from 'ai';
import {
  ConcurrencyLimiter,
  getEffectiveProviderConcurrency,
  getProviderConcurrencyKey,
  getProviderLimiter,
  setProviderConcurrencyOverrides,
} from '../../../src/host/model/concurrencyLimiter';
import { inferenceViaAiSdk } from '../../../src/host/model/adapters/aiSdkAdapter';
import type { ModelConfig } from '../../../src/shared/contract';

vi.mock('../../../src/host/model/providers/providerResolution', () => ({
  resolveProviderBaseUrl: () => 'https://test.local/v1',
  resolveProviderApiKey: () => 'test-key',
}));

vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>();
  return { ...actual, streamText: vi.fn(), generateText: vi.fn() };
});

afterEach(() => {
  setProviderConcurrencyOverrides({});
  vi.mocked(streamText).mockReset();
  vi.mocked(generateText).mockReset();
});

describe('ConcurrencyLimiter', () => {
  it('caps in-flight requests at maxConcurrent and queues the rest', async () => {
    const limiter = new ConcurrencyLimiter('test', 2, 0);

    // 抢占 2 个许可（达到上限）
    await limiter.acquire();
    await limiter.acquire();

    // 第 3 个应被排队，不立即 resolve
    let third = false;
    const p = limiter.acquire().then(() => { third = true; });
    await new Promise(r => setTimeout(r, 10));
    expect(third).toBe(false);

    // 释放一个 → 队列里的第 3 个被放行
    limiter.release();
    await p;
    expect(third).toBe(true);
  });

  it('降级后并发上限下降（onRateLimit）', async () => {
    const limiter = new ConcurrencyLimiter('test', 2, 0);
    limiter.onRateLimit(); // 2 → 1

    await limiter.acquire(); // 占满 1
    let second = false;
    const p = limiter.acquire().then(() => { second = true; });
    await new Promise(r => setTimeout(r, 10));
    expect(second).toBe(false); // 降级后上限=1，第 2 个排队

    limiter.release();
    await p;
    expect(second).toBe(true);
  });

  it('removes an aborted waiter without consuming the next released slot', async () => {
    const limiter = new ConcurrencyLimiter('test', 1, 0);
    await limiter.acquire();

    const controller = new AbortController();
    const queued = limiter.acquire(controller.signal);
    controller.abort();
    await expect(queued).rejects.toThrow('cancelled while waiting');

    limiter.release();
    await expect(limiter.acquire()).resolves.toBeUndefined();
    limiter.release();
  });
});

describe('getProviderLimiter', () => {
  it('为声明了并发上限的 provider（zhipu）返回限流器', () => {
    expect(getProviderLimiter('zhipu')).toBeInstanceOf(ConcurrencyLimiter);
  });

  it('为声明了默认并发上限的 provider（xiaomi）返回限流器', () => {
    expect(getProviderLimiter('xiaomi')).toBeInstanceOf(ConcurrencyLimiter);
  });

  it('为未声明的 provider 返回 null', () => {
    expect(getProviderLimiter('unknown-provider')).toBeNull();
  });

  it('空 provider 返回 null', () => {
    expect(getProviderLimiter(undefined)).toBeNull();
    expect(getProviderLimiter(null)).toBeNull();
  });

  it('同一 provider 复用同一实例', () => {
    expect(getProviderLimiter('zhipu')).toBe(getProviderLimiter('zhipu'));
  });

  it('normalizes provider aliases before resolving overrides and limiter instances', () => {
    setProviderConcurrencyOverrides({
      anthropic: { maxConcurrent: 2, minIntervalMs: 0 },
    });

    expect(getProviderConcurrencyKey(' anthropic ')).toBe('claude');
    expect(getEffectiveProviderConcurrency('claude')).toBe(2);
    expect(getProviderLimiter('anthropic')).toBe(getProviderLimiter('claude'));
  });
});

describe('inferenceViaAiSdk shared concurrency gate (foreground + background-style requests)', () => {
  const config: ModelConfig = {
    provider: 'openai',
    model: 'gpt-5.4',
    temperature: 0.7,
  } as ModelConfig;

  async function measureForegroundAndBackgroundMaxInFlight(): Promise<number> {
    let activeInFlight = 0;
    let maxInFlight = 0;

    vi.mocked(streamText).mockImplementation((() => {
      activeInFlight++;
      maxInFlight = Math.max(maxInFlight, activeInFlight);
      return {
        stream: (async function* () {
          try {
            await new Promise((r) => setTimeout(r, 30));
            yield { type: 'text-delta', text: 'foreground-ok' };
            yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 5 } };
          } finally {
            activeInFlight--;
          }
        })(),
      };
    }) as unknown as typeof streamText);

    vi.mocked(generateText).mockImplementation((async () => {
      activeInFlight++;
      maxInFlight = Math.max(maxInFlight, activeInFlight);
      try {
        await new Promise((r) => setTimeout(r, 30));
        return {
          text: 'background-ok',
          toolCalls: [],
          reasoningText: '',
          usage: { inputTokens: 12, outputTokens: 6 },
          finishReason: 'stop',
        };
      } finally {
        activeInFlight--;
      }
    }) as unknown as typeof generateText);

    const [fgRes, bgRes] = await Promise.all([
      inferenceViaAiSdk([{ role: 'user', content: 'fg' }], [], config, () => {}),
      inferenceViaAiSdk([{ role: 'user', content: 'bg' }], [], config, undefined),
    ]);

    expect(fgRes.content).toBe('foreground-ok');
    expect(bgRes.content).toBe('background-ok');
    return maxInFlight;
  }

  it('serializes foreground and background-style requests to max in-flight = 1 when provider cap is 1', async () => {
    setProviderConcurrencyOverrides({
      openai: { maxConcurrent: 1, minIntervalMs: 0 },
    });

    const maxInFlight = await measureForegroundAndBackgroundMaxInFlight();
    expect(maxInFlight).toBe(1);
  });

  it('allows foreground and background-style requests to overlap at max in-flight = 2 when no cap is set', async () => {
    setProviderConcurrencyOverrides({});

    const maxInFlight = await measureForegroundAndBackgroundMaxInFlight();
    expect(maxInFlight).toBe(2);
  });
});
