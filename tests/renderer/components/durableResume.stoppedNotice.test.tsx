// @vitest-environment jsdom
// N-QUIT-STOP-REOPEN-HALF-STATE-FU2：user_stop 停靠行旁的「你停止了这次任务」说明。
// N-FIX-STEP-HEADER-AND-STOPPED-ROW-REPEAT：停靠行只说原因（谁/为什么），操作入口只在输入框一处；
// 环境授权停车说在等什么、不出「继续」；输入框上方已有录制条时让位不叠行。
// 装配镜像 ChatView 的接线（同 durableResume.abandonState.test.tsx 的 ParkedRow 先例）。
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: vi.fn(async () => undefined), invokeDomain: vi.fn(async () => undefined) },
  invoke: vi.fn(async () => undefined),
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import {
  DurableParkedNotice,
  DurableResumeNotice,
  isParkedForUser,
  shouldShowParkedNotice,
  useParkedNoticeYields,
  useAbandonParkedRun,
  useDurableContinueVisible,
} from '../../../src/renderer/components/features/chat/durableResume';
import { SendButton } from '../../../src/renderer/components/features/chat/ChatInput/SendButton';
import { useI18n } from '../../../src/renderer/hooks/useI18n';

type Resume = { mode: string; canContinue: boolean; runId?: string; interruptCause?: string; quotaWait?: unknown; envBlocked?: { class: 'perm_automation'; target: string; toolCallId: string } };

function ParkedRow({ resume, turnActive, statusBar = false }: { resume: Resume | undefined; turnActive: boolean; statusBar?: boolean }) {
  const { t } = useI18n();
  const show = useDurableContinueVisible(resume, turnActive);
  const abandon = useAbandonParkedRun('s1', resume?.runId);
  return (
    <>
      {resume?.mode === 'auto-resuming' && <DurableResumeNotice text={t.chat.durableResumeNotice} />}
      {resume?.mode === 'queued' && <DurableResumeNotice text={t.chat.durableResumeQueuedNotice} />}
      {shouldShowParkedNotice(resume, turnActive, statusBar) && (
        <DurableParkedNotice interruptCause={resume?.interruptCause} envBlocked={resume?.envBlocked} />
      )}
      <SendButton hasContinuation={show} canAbandon={isParkedForUser(resume, turnActive)} isProcessing={turnActive} onContinue={() => undefined} onAbandon={abandon.onAbandon} onStop={() => undefined} />
    </>
  );
}

const STOP: Resume = { mode: 'continue', canContinue: true, runId: 'r1', interruptCause: 'user_stop' };
const NOTICE = 'durable-stopped-notice';

describe('durable stopped notice (user_stop)', () => {
  beforeEach(() => {
    useSessionStore.setState({ loadSessions: vi.fn(async () => undefined) } as never);
    useAppStore.setState({ language: 'zh' } as never);
  });

  it('① shows zh text beside Continue and Abandon; en locale shows en text', () => {
    const { unmount } = render(<ParkedRow resume={STOP} turnActive={false} />);
    expect(screen.getByTestId(NOTICE).textContent).toContain('你停止了这次任务 · 点「继续」可接着做');
    expect(screen.getByTestId('continue-run-button')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^(放弃|Abandon)$/ })).toBeTruthy();
    unmount();
    useAppStore.setState({ language: 'en' } as never);
    render(<ParkedRow resume={STOP} turnActive={false} />);
    expect(screen.getByTestId(NOTICE).textContent).toContain('You stopped this task · press Continue to pick it up');
  });

  it('② each continuable cause says why it stopped; hidden for other modes, active turn, quota wait and canContinue=false', () => {
    const reasons: Array<[string, string]> = [
      ['guard_halt', '上一步不确定有没有做完'],
      ['budget_exhausted', '应用多次意外退出'],
    ];
    for (const [cause, text] of reasons) {
      const { unmount } = render(<ParkedRow resume={{ ...STOP, interruptCause: cause }} turnActive={false} />);
      expect(screen.getByTestId(NOTICE).textContent).toContain(text);
      expect(screen.getByTestId(NOTICE).textContent).not.toContain('任务已停止');
      unmount();
    }
    const hidden: Array<[Resume, boolean]> = [
      [{ ...STOP, quotaWait: { dueAt: 1, duePassed: false } }, false],
      [{ mode: 'auto-resuming', canContinue: false, interruptCause: 'user_stop' }, false],
      [{ mode: 'queued', canContinue: false, interruptCause: 'user_stop' }, false],
      [STOP, true],
      [{ ...STOP, canContinue: false }, false],
    ];
    for (const [resume, active] of hidden) {
      const { unmount } = render(<ParkedRow resume={resume} turnActive={active} />);
      expect(screen.queryByTestId(NOTICE)).toBeNull();
      unmount();
    }
  });

  it('③ one action entry: the parked row carries no buttons, Continue + Abandon sit together in the composer', () => {
    render(<ParkedRow resume={{ ...STOP, interruptCause: 'guard_halt' }} turnActive={false} />);
    expect(within(screen.getByTestId(NOTICE)).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getAllByTestId('continue-run-control')).toHaveLength(1);
    expect(screen.getAllByTestId('continue-run-button')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^(放弃|Abandon)$/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^(放弃|Abandon)$/ }).closest('[data-testid="continue-run-control"]')).not.toBeNull();
  });

  it('④ yields to a composer status bar (recording / loop) instead of stacking another row; Continue stays', () => {
    render(<ParkedRow resume={STOP} turnActive={false} statusBar />);
    expect(screen.queryByTestId(NOTICE)).toBeNull();
    expect(screen.getByTestId('continue-run-button')).toBeTruthy();
  });

  it('⑤ env_blocked park says what it waits for, never 中断/已停止; no Continue, Abandon stays beside Send (not in the row)', () => {
    const env: Resume = { ...STOP, interruptCause: 'env_blocked', envBlocked: { class: 'perm_automation', target: 'calendar', toolCallId: 'c1' } };
    render(<ParkedRow resume={env} turnActive={false} />);
    const text = screen.getByTestId(NOTICE).textContent ?? '';
    expect(text).toBe('等你允许日历 · 允许后自动继续');
    expect(text).not.toMatch(/中断|已停止/);
    expect(screen.queryByTestId('continue-run-button')).toBeNull();
    expect(screen.queryByRole('button', { name: /^(继续|Continue)$/ })).toBeNull();
    expect(within(screen.getByTestId(NOTICE)).queryAllByRole('button')).toHaveLength(0);
    // 不想授权的用户仍能放弃：自动续做的等待窗口有上限（envResumeWaiter），放弃入口不能跟着「继续」一起消失
    expect(screen.getAllByRole('button', { name: /^(放弃|Abandon)$/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^(放弃|Abandon)$/ }).closest('[data-testid="continue-run-control"]')).not.toBeNull();
  });

  it('⑥ env_blocked park with an open grant card in this turn: the card says it all, the parked row is not rendered; resolved card / no card brings the row back', () => {
    const env: Resume = { ...STOP, interruptCause: 'env_blocked', envBlocked: { class: 'perm_automation', target: 'calendar', toolCallId: 'c1' } };
    function WiredRow() {
      const yields = useParkedNoticeYields(env as never);
      return shouldShowParkedNotice(env, false, yields)
        ? <DurableParkedNotice interruptCause={env.interruptCause} envBlocked={env.envBlocked} />
        : null;
    }
    const card = (phase: string) => ({
      id: 'env-assist:r1|perm_automation|calendar', role: 'assistant', content: '', timestamp: 1,
      metadata: { envAssist: { id: 'r1|perm_automation|calendar', sessionId: 's1', runId: 'r1', class: 'perm_automation',
        target: { id: 'calendar', labelKey: 'env.target.calendar' }, phase, sentenceKey: 'env.sentence.calendar',
        resume: { mode: 'manual' }, updatedAt: 1 } },
    });
    useSessionStore.setState({ messages: [card('needs_user')] } as never);
    const { rerender } = render(<WiredRow />);
    expect(screen.queryByTestId(NOTICE)).toBeNull();
    useSessionStore.setState({ messages: [card('resolved')] } as never);
    rerender(<WiredRow />);
    expect(screen.getByTestId(NOTICE).textContent).toBe('等你允许日历 · 允许后自动继续');
    useSessionStore.setState({ messages: [] } as never);
    rerender(<WiredRow />);
    expect(screen.getByTestId(NOTICE).textContent).toBe('等你允许日历 · 允许后自动继续');
  });
});

