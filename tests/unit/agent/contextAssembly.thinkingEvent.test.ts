import { describe, expect, it, vi } from 'vitest';

const debugSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/infra/logger')>();
  return {
    ...actual,
    createLogger: () => ({ debug: debugSpy, info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  };
});

import { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import { TurnState } from '../../../src/host/agent/runtime/turnState';

describe('ContextAssembly.maybeInjectThinking', () => {
  for (const effort of ['high', 'xhigh'] as const) {
    it(`does not emit a user-visible "Thinking Step" event at effort ${effort}`, async () => {
      const turn = TurnState.forTest({ effortLevel: effort });
      const onEvent = vi.fn();
      const runtime = { onEvent, turn, scaffoldProfile: undefined };
      const assembly = new ContextAssembly(runtime as never);
      const inject = vi.spyOn(assembly as never, 'injectAdvisoryTailMessage' as never).mockImplementation((() => {}) as never);

      // high 档每隔一次才注入：跑两轮保证命中
      for (let i = 0; i < 2; i++) await assembly.maybeInjectThinking([], []);

      expect(inject).toHaveBeenCalled();
      const texts = onEvent.mock.calls.map((c) => JSON.stringify(c[0]));
      expect(texts.some((t) => t.includes('Thinking Step') || t.includes('Effort:'))).toBe(false);
      expect(onEvent.mock.calls.some((c) => c[0]?.type === 'agent_thinking')).toBe(false);
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('Thinking step'));
    });
  }
});
