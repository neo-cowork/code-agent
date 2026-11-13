// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { agentErrorZh, agentErrorEn } from '../../../src/renderer/i18n/agentError';
const runtime = vi.hoisted(() => ({ invokeDomain: vi.fn(), language: 'zh' }));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invokeDomain: runtime.invokeDomain } }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: runtime.language === 'zh' ? agentErrorZh : agentErrorEn }) }));
import { useLiveBackgroundAgentCount } from '../../../src/renderer/hooks/useLiveBackgroundAgentCount';
import { BackgroundChildrenNotice } from '../../../src/renderer/components/features/chat/BackgroundChildrenNotice';

afterEach(() => { cleanup(); vi.useRealTimers(); runtime.invokeDomain.mockReset(); });
it.each(['zh', 'en'])('shows %s continuation copy while a child lives and removes it after completion without remount', async (language) => {
  vi.useFakeTimers(); runtime.language = language;
  let terminal = false;
  runtime.invokeDomain.mockImplementation(async () => ({ sessionId: 'session', nodes: [{ background: true, status: terminal ? 'completed' : 'running' }] }));
  render(<BackgroundChildrenNotice sessionId="session" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByTestId('background-children-notice').textContent).toBe(language === 'zh'
    ? '后台还有 1 个代理在继续，完成后会告诉你'
    : '1 agent is still working in the background. I’ll let you know when it finishes.');
  terminal = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.queryByTestId('background-children-notice')).toBeNull();
  const reads = runtime.invokeDomain.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(runtime.invokeDomain).toHaveBeenCalledTimes(reads);
});

it('observes a child that starts after the first empty snapshot while its parent is still running', async () => {
  vi.useFakeTimers();
  let live = false;
  runtime.invokeDomain.mockImplementation(async () => ({ sessionId: 'session', nodes: live ? [{ background: true, status: 'running' }] : [] }));
  const hook = renderHook(() => useLiveBackgroundAgentCount('session', true, true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(hook.result.current).toBe(0);
  live = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(hook.result.current).toBe(1);
});
