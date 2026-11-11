// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, MessageMetadata } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';
import { TurnBasedTraceView, getFocusedTurnIndex, getOutputFollowTurnIndex } from '../../../src/renderer/components/features/chat/TurnBasedTraceView';
import { useAppStore } from '../../../src/renderer/stores/appStore';

// Static rendering reads Zustand's initial snapshot; supply the selected language explicitly.
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { languages } = await import('../../../src/renderer/i18n');
  return { useI18n: () => ({ t: languages[useAppStore.getState().language] }) };
});

const receipt: NonNullable<MessageMetadata['roleEditReceipt']> = {
  roleId: '研究员', addedTools: ['calendar', 'read_calendar', 'private_future_tool'], removedTools: ['Write'],
  descriptionChanged: false, promptChanged: false, diffAvailable: true,
};
function renderRow(detail = receipt) {
  const message: Message = { id: 'receipt', role: 'system', content: 'Expert updated.', timestamp: 2, metadata: { roleEditReceipt: detail } };
  const nodes = projectTurns([{ id: 'user', role: 'user', content: 'Add calendar', timestamp: 1 }, message], 'session', false)
    .turns.flatMap((turn) => turn.nodes);
  const node = nodes.find((item) => item.id === message.id);
  expect(node).toBeDefined();
  return renderToStaticMarkup(<TraceNodeRenderer node={node!} />);
}

// Only replace virtual layout; the chat view, TurnCard and node renderer are real.
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

afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh', disclosureLevel: 'standard' }); });
describe('role edit receipt projection and rendering', () => {
  it.each(['zh', 'en'] as const)('renders the receipt after the final answer in its own turn in %s', (language) => {
    useAppStore.setState({ language, disclosureLevel: 'simple' });
    const messages: Message[] = [
      { id: 'u', role: 'user', content: 'Add news research to my expert', timestamp: 1 },
      { id: 'a-intro', role: 'assistant', content: 'I have prepared the changes.', timestamp: 2 },
      { id: 'a-final', role: 'assistant', content: 'The edited draft is ready. Please confirm.', timestamp: 3 },
      { id: 'receipt', role: 'system', content: 'Expert updated.', timestamp: 4, metadata: { roleEditReceipt: receipt } },
    ];
    const projection = projectTurns(messages, 'session', false);
    const { container, rerender } = render(<TurnBasedTraceView projection={projection} />);
    const receiptText = language === 'zh' ? /已更新专家「研究员」/ : /Updated expert “研究员”/;
    const answer = screen.getByText('The edited draft is ready. Please confirm.');
    const row = screen.getByText(receiptText);
    expect(answer.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const receiptTurn = row.closest('[data-trace-turn-id]');
    expect(receiptTurn).not.toBeNull();
    expect(receiptTurn?.getAttribute('data-trace-turn-id')).not.toBe(answer.closest('[data-trace-turn-id]')?.getAttribute('data-trace-turn-id'));
    expect(receiptTurn?.querySelector('[data-testid="turn-reply-actions"]')).toBeNull();
    expect(receiptTurn?.querySelector('button')).toBeNull();
    expect(receiptTurn?.querySelector('[data-testid="turn-run-header"]')).toBeNull();
    expect(getFocusedTurnIndex(projection)).toBe(0);
    expect(getOutputFollowTurnIndex(projection, projection.turns[1].turnId, true)).toBe(-1);
    const followup: Message[] = [...messages,
      { id: 'u-next', role: 'user', content: 'Plan my next industry briefing', timestamp: 5 },
      { id: 'a-next', role: 'assistant', content: 'Here is your briefing plan.', timestamp: 6 }];
    rerender(<TurnBasedTraceView projection={projectTurns(followup, 'session', false)} />);
    expect(screen.getByText(receiptText).compareDocumentPosition(screen.getByText('Here is your briefing plan.')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll('[data-trace-turn-id]')).toHaveLength(3);
  });
  it.each(['zh', 'en'] as const)('renders plain capability names in %s', (language) => {
    useAppStore.setState({ language });
    const html = renderRow();
    expect(html).toContain(language === 'zh' ? '已更新专家「研究员」。' : 'Updated expert “研究员”.');
    expect(html).toContain(language === 'zh' ? '日历' : 'Calendar');
    expect(html).toContain(language === 'zh' ? '移除能力：写入和编辑文件。' : 'Removed capabilities: Write and edit files.');
    expect(html).toContain(language === 'zh' ? '简介未变。' : 'Description unchanged.');
    expect(html).toContain(language === 'zh' ? '工作规则未变。' : 'Working rules unchanged.');
    expect(html).not.toMatch(/read_calendar|private_future_tool|Expert updated\./);
  });
  it.each(['zh', 'en'] as const)('renders unchanged and unavailable comparisons distinctly in %s', (language) => {
    useAppStore.setState({ language });
    const unchanged = { ...receipt, addedTools: [], removedTools: [] };
    expect(renderRow(unchanged)).toContain(language === 'zh' ? '能力、简介和工作规则均未变化。' : 'capabilities, description and working rules are unchanged.');
    expect(renderRow({ ...unchanged, diffAvailable: false })).toContain(language === 'zh' ? '但无法比较本次变化。' : 'but the changes could not be compared.');
    expect(renderRow({ ...unchanged, descriptionChanged: true, promptChanged: true }))
      .toContain(language === 'zh' ? '工作规则已更新。' : 'Working rules updated.');
  });
});

// ============================================================================
// N-FIX-SIGNED-OUT-SEND-500-RAW-HTML-REDESIGN：PROJECT_SOURCE_TRUST 失败气泡的
// 「确认并重发」入口——点按钮先调宿主确认端点（只带 sessionId），成功后走既有
// 失败重发路径（复用原 clientMessageId 原样重发）；确认失败换通用失败句。
// ============================================================================
const unsafeInvokeMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(),
    invokeDomain: vi.fn(),
    unsafeInvoke: unsafeInvokeMock,
  },
}));

describe('ProjectTrustConfirmCard 确认并重发', () => {
  const failedMessages: Message[] = [
    {
      id: 'client-msg-keep',
      role: 'user',
      content: '帮我把下载文件夹里的照片按日期改名',
      timestamp: 1,
      metadata: { sendFailed: true },
    },
    {
      id: 'err-1',
      role: 'assistant',
      content: '这个项目文件夹需要你确认后 Neo 才能使用。',
      timestamp: 2,
      metadata: {
        retryPrompt: '帮我把下载文件夹里的照片按日期改名',
        retryClientMessageId: 'client-msg-keep',
        retrySessionId: 'session-trust',
        sendFailureCode: 'PROJECT_SOURCE_TRUST',
      },
    },
  ];

  function failedAssistantNode() {
    const nodes = projectTurns(failedMessages, 'session-trust', false)
      .turns.flatMap((turn) => turn.nodes);
    const node = nodes.find((item) => item.messageId === 'err-1' || item.id.startsWith('err-1'));
    expect(node).toBeDefined();
    return node!;
  }

  it('确认成功后按原 clientMessageId 原样重发', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const { useMessageActionStore } = await import('../../../src/renderer/stores/messageActionStore');
    const sendSpy = vi.fn();
    useMessageActionStore.setState({ _send: sendSpy, _getMessages: () => failedMessages });
    unsafeInvokeMock.mockResolvedValue({ confirmed: true, sources: 1 });

    render(<TraceNodeRenderer node={failedAssistantNode()} sessionId="session-trust" />);

    const button = screen.getByRole('button', { name: '确认并重发' });
    fireEvent.click(button);

    await vi.waitFor(() => {
      expect(unsafeInvokeMock).toHaveBeenCalledWith('project:confirm-source-trust', { sessionId: 'session-trust' });
      expect(sendSpy).toHaveBeenCalledWith('帮我把下载文件夹里的照片按日期改名', {
        clientMessageId: 'client-msg-keep',
      });
    });
    // 已发出后按钮消失，不留双入口
    expect(screen.queryByRole('button', { name: '确认并重发' })).toBeNull();
    useMessageActionStore.setState({ _send: null, _getMessages: null });
  });

  it('确认失败显示通用失败句，不透传内部码', async () => {
    const { fireEvent } = await import('@testing-library/react');
    unsafeInvokeMock.mockResolvedValue(undefined); // 端点拒绝/坍缩 → 未确认

    render(<TraceNodeRenderer node={failedAssistantNode()} sessionId="session-trust" />);

    fireEvent.click(screen.getByRole('button', { name: '确认并重发' }));

    await vi.waitFor(() => {
      expect(screen.getByText('Neo 暂时没能完成这次请求，请稍后再试。')).toBeTruthy();
    });
    expect(document.body.textContent).not.toContain('PROJECT_SOURCE_TRUST');
    expect(document.body.textContent).not.toContain('confirm unavailable');
  });
});
