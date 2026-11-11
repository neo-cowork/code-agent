// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEventEnvelope } from '../../../src/shared/contract';
import { RUN_ERROR_CODE_MAX_ITERATIONS } from '../../../src/shared/constants';

let listener: ((event: AgentEventEnvelope) => void) | undefined;
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: {
  on: (_channel: string, callback: typeof listener) => {
    listener = callback;
    return () => { listener = undefined; };
  },
  invoke: vi.fn(async () => undefined),
} }));

import { useSessionLifecycleEffects } from '../../../src/renderer/hooks/agent/effects/useSessionLifecycleEffects';
import type { AgentEffectsProps } from '../../../src/renderer/hooks/agent/useAgentEffects';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useTerminalRunGuardStore } from '../../../src/renderer/stores/terminalRunGuardStore';

afterEach(() => vi.restoreAllMocks());

describe('useSessionLifecycleEffects step-limit error subscription', () => {
  it.each([true, false])('marker=%s controls the live failure card and still clears processing', async (marked) => {
    const sessionId = 'step-limit-session';
    useSessionStore.setState({ currentSessionId: sessionId, messages: [{
      id: 'summary', role: 'assistant', content: 'Saved progress; more notes remain.', timestamp: 1,
      ...(marked ? { metadata: { stoppedByStepLimit: true } } : {}),
    }] });
    vi.spyOn(useSessionStore.getState(), 'refreshContextHealth').mockResolvedValue(null);
    useAppStore.getState().setSessionProcessing(sessionId, true);
    useTerminalRunGuardStore.getState().rearmForNewRun(sessionId);
    const props = {
      currentTurnMessageIdRef: { current: null }, flushRef: { current: vi.fn() },
      lastEventAtRef: { current: Date.now() },
      setActiveToolProgress: vi.fn(), setIsInterrupting: vi.fn(), setIsProcessing: vi.fn(),
      setResearchDetected: vi.fn(), setSessionTaskComplete: vi.fn(), setSessionTaskProgress: vi.fn(),
      setTodos: vi.fn(), setToolTimeoutWarning: vi.fn(), setPendingPermissionRequest: vi.fn(),
      enqueuePermissionRequest: vi.fn(), updateMessage: vi.fn(),
    } as unknown as AgentEffectsProps;
    const hook = renderHook(() => useSessionLifecycleEffects(props));
    await act(async () => listener?.({ type: 'error', sessionId, streamEpoch: 'http:step-limit-test', seq: 1, data: {
      message: 'Max iterations reached', code: RUN_ERROR_CODE_MAX_ITERATIONS,
      ...(marked ? { details: { stoppedByStepLimit: true } } : {}),
    } }));
    const messages = useSessionStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Saved progress; more notes remain.');
    if (marked) expect(messages[0].metadata?.agentError).toBeUndefined();
    else expect(messages[0].metadata?.agentError).toMatchObject({ category: 'generic' });
    expect(useAppStore.getState().processingSessionIds.has(sessionId)).toBe(false);
    expect(useTerminalRunGuardStore.getState().hasTerminal(sessionId)).toBe(true);
    expect(useTerminalRunGuardStore.getState().hasUnendedRun(sessionId)).toBe(false);
    hook.unmount();
  });
});
