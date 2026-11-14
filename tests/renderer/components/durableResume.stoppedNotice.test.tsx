// @vitest-environment jsdom
// N-QUIT-STOP-REOPEN-HALF-STATE-FU2：user_stop 停靠行旁的「你停止了这次任务」说明。
// 装配镜像 ChatView 的接线（同 durableResume.abandonState.test.tsx 的 ParkedRow 先例）。
import React from 'react';
import { render, screen } from '@testing-library/react';
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
  shouldShowParkedNotice,
  useAbandonParkedRun,
  useDurableContinueVisible,
} from '../../../src/renderer/components/features/chat/durableResume';
import { SendButton } from '../../../src/renderer/components/features/chat/ChatInput/SendButton';
import { useI18n } from '../../../src/renderer/hooks/useI18n';

type Resume = { mode: string; canContinue: boolean; runId?: string; interruptCause?: string; quotaWait?: unknown };

function ParkedRow({ resume, turnActive }: { resume: Resume | undefined; turnActive: boolean }) {
  const { t } = useI18n();
  const show = useDurableContinueVisible(resume, turnActive);
  const abandon = useAbandonParkedRun('s1', resume?.runId);
  return (
    <>
      {resume?.mode === 'auto-resuming' && <DurableResumeNotice text={t.chat.durableResumeNotice} />}
      {resume?.mode === 'queued' && <DurableResumeNotice text={t.chat.durableResumeQueuedNotice} />}
      {shouldShowParkedNotice(show, resume) && (
        <DurableParkedNotice interruptCause={resume?.interruptCause} actions={
          <button type="button" onClick={abandon.onAbandon}>{t.chat.durableAbandon}</button>
        } />
      )}
      <SendButton hasContinuation={show} isProcessing={turnActive} onContinue={() => undefined} onStop={() => undefined} />
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

  it('② hidden for other causes, modes, active turn and canContinue=false', () => {
    const cases: Array<[Resume, boolean]> = [
      [{ ...STOP, interruptCause: 'guard_halt' }, false],
      [{ ...STOP, interruptCause: 'budget_exhausted' }, false],
      [{ ...STOP, interruptCause: 'crash_or_quit' }, false],
      [{ ...STOP, quotaWait: { dueAt: 1, duePassed: false } }, false],
      [{ mode: 'auto-resuming', canContinue: false, interruptCause: 'user_stop' }, false],
      [{ mode: 'queued', canContinue: false, interruptCause: 'user_stop' }, false],
      [STOP, true],
      [{ ...STOP, canContinue: false }, false],
    ];
    for (const [resume, active] of cases) {
      const { unmount } = render(<ParkedRow resume={resume} turnActive={active} />);
      expect(screen.queryByTestId(NOTICE)).toBeNull();
      unmount();
    }
  });

  it('non-user_stop continue keeps the legacy parked row with Continue and Abandon', () => {
    render(<ParkedRow resume={{ ...STOP, interruptCause: 'guard_halt' }} turnActive={false} />);
    expect(screen.getByTestId('durable-resume-notice').textContent).toContain('任务已停止');
    expect(screen.getByTestId('continue-run-button')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^(放弃|Abandon)$/ })).toBeTruthy();
  });
});
