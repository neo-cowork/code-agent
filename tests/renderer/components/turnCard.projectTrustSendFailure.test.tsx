// @vitest-environment jsdom
// N-FIX-SIGNED-OUT-SEND-500-RAW-HTML-FU1：PROJECT_SOURCE_TRUST 发送失败轮只留一句人话 + 一个确认按钮，
// 不再叠通用失败装饰；其它发送失败保持原装饰。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TurnBasedTraceView } from '../../../src/renderer/components/features/chat/TurnBasedTraceView';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';
import { projectSourceTrustCopy } from '../../../src/renderer/i18n/agentRunErrors';
import { languages } from '../../../src/renderer/i18n';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { languages: langs } = await import('../../../src/renderer/i18n');
  const { useAppStore: store } = await import('../../../src/renderer/stores/appStore');
  return { useI18n: () => ({ t: langs[store((s) => s.language)] }) };
});

vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react');
  return { Virtuoso: ReactModule.forwardRef(function Layout(props: {
    data: import('../../../src/shared/contract/trace').TraceTurn[];
    firstItemIndex: number;
    itemContent: (index: number, turn: import('../../../src/shared/contract/trace').TraceTurn) => React.ReactNode;
  }, ref) {
    ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex() {}, autoscrollToBottom() {} }));
    return <div>{props.data.map((turn, index) => <React.Fragment key={turn.turnId}>
      {props.itemContent(props.firstItemIndex + index, turn)}
    </React.Fragment>)}</div>;
  }) };
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
  useTaskStore.setState({ sessionStates: {} });
});

const PROMPT = '帮我把下载文件夹里的照片按日期改名';

function renderFailedTurn(language: 'zh' | 'en', failure: 'trust' | 'generic') {
  useAppStore.setState({ language });
  useTaskStore.getState().updateSessionState('session', { status: 'error', error: 'send failed' });
  const messages: Message[] = [
    { id: 'u', role: 'user', content: PROMPT, timestamp: 1, metadata: { sendFailed: true } },
    {
      id: 'e', role: 'assistant', timestamp: 2,
      content: failure === 'trust' ? projectSourceTrustCopy[language] : 'Local server request failed',
      metadata: {
        retryPrompt: PROMPT, retryClientMessageId: 'u', retrySessionId: 'session',
        ...(failure === 'trust' ? { sendFailureCode: 'PROJECT_SOURCE_TRUST' } : {}),
      },
    },
  ];
  return render(<TurnBasedTraceView projection={projectTurns(messages, 'session', false)} />);
}

describe('PROJECT_SOURCE_TRUST send failure presentation', () => {
  it.each(['zh', 'en'] as const)('shows only the sentence and one confirm button in %s', (language) => {
    const { container } = renderFailedTurn(language, 'trust');
    const t = languages[language];
    expect(screen.getAllByText(projectSourceTrustCopy[language])).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /确认并重发|Confirm and resend/ })).toHaveLength(1);
    const text = container.textContent ?? '';
    for (const banned of [
      t.turnCard.sendFailed, t.turnRun.status.blocked, t.turnRun.detail.blocked,
      '没发出去', '编辑重发', '遇到问题', '本轮运行遇到错误',
      'Not sent', 'Edit and resend', 'Ran into a problem',
    ]) expect(text).not.toContain(banned);
    expect(screen.queryByTestId('user-message-send-failed')).toBeNull();
    expect(screen.queryByTestId('user-message-edit-resend')).toBeNull();
    expect(screen.queryByTestId('turn-run-header')).toBeNull();
  });

  it('keeps the generic decorations for a non-trust send failure', () => {
    const { container } = renderFailedTurn('zh', 'generic');
    const t = languages.zh;
    expect(screen.getByTestId('user-message-send-failed')).toBeTruthy();
    expect(screen.getByTestId('user-message-edit-resend')).toBeTruthy();
    expect(container.textContent).toContain(t.turnRun.status.blocked);
    expect(container.textContent).toContain(t.turnRun.detail.blocked);
    expect(screen.queryByRole('button', { name: /确认并重发|Confirm and resend/ })).toBeNull();
  });
});
