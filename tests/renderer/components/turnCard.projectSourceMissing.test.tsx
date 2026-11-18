// @vitest-environment jsdom
// source_missing 走真实发送失败路径：useAgentIPC -> 失败消息 -> TurnBasedTraceView
// （TraceNodeRenderer / ProjectTrustConfirmCard）。not_trusted 仍是确认卡。
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { TurnBasedTraceView } from '../../../src/renderer/components/features/chat/TurnBasedTraceView';
import { useAgentIPC } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { languages, type Language } from '../../../src/renderer/i18n';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { clearFailedSend } from '../../../src/renderer/stores/failedSendOutbox';
import { useMessageActionStore } from '../../../src/renderer/stores/messageActionStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSwarmStore } from '../../../src/renderer/stores/swarmStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';

const invokeMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
    invokeDomain: vi.fn(),
    unsafeInvoke: confirmMock,
  },
}));

vi.mock('../../../src/renderer/hooks/useI18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/hooks/useI18n')>();
  const { languages: langs } = await import('../../../src/renderer/i18n');
  const { useAppStore: store } = await import('../../../src/renderer/stores/appStore');
  return { ...actual, useI18n: () => ({ t: langs[store((s) => s.language)] }) };
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

vi.mock('../../../src/renderer/components/ProjectSettingsDialog', () => ({
  ProjectSettingsDialog: ({ open, onSaved }: {
    open: boolean;
    onSaved?: (detail: { project: { id: string } }) => void;
  }) => (open ? <button type="button" onClick={() => onSaved?.({ project: { id: 'proj-missing' } })}>保存文件夹</button> : null),
}));

const SESSION_ID = 'session-missing';
const PROMPT = '请只回复：收到';

function trustError(kind: 'source_missing' | 'not_trusted', folderName?: string) {
  return Object.assign(new Error('Project folder needs trust confirmation'), {
    status: 422,
    code: 'PROJECT_SOURCE_TRUST',
    kind,
    ...(folderName ? { folderName } : {}),
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  confirmMock.mockReset();
  localStorage.clear();
  clearFailedSend(SESSION_ID);
  useAppStore.setState({ language: 'zh', isProcessing: false, processingSessionIds: new Set() });
  useSessionStore.setState({
    currentSessionId: SESSION_ID,
    messages: [],
    sessions: [{
      id: SESSION_ID,
      projectId: 'proj-missing',
      title: 'Weekly notes',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
      turnCount: 0,
      modelConfig: useAppStore.getState().modelConfig,
    }],
  });
  useSwarmStore.getState().reset();
  useTaskStore.setState({ sessionStates: { [SESSION_ID]: { status: 'idle' } } });
});

afterEach(() => {
  cleanup();
  useMessageActionStore.getState().unregister();
  localStorage.clear();
  clearFailedSend(SESSION_ID);
  useAppStore.setState({ language: 'zh', isProcessing: false, processingSessionIds: new Set() });
  useSessionStore.setState({ currentSessionId: null, sessions: [], messages: [] });
  useTaskStore.setState({ sessionStates: {} });
});

async function sendAndFail(language: Language, error: unknown) {
  useAppStore.setState({ language });
  invokeMock.mockRejectedValueOnce(error);
  const hook = renderHook(() => useAgentIPC({
    addMessage: useSessionStore.getState().addMessage,
    currentSessionId: SESSION_ID,
    currentTurnMessageIdRef: { current: null },
    isProcessing: false,
    setIsProcessing: vi.fn(),
    setSessionProcessing: useAppStore.getState().setSessionProcessing,
  }));
  await act(async () => {
    const delivery = await hook.result.current.sendMessage({
      content: PROMPT,
      sessionId: SESSION_ID,
      clientMessageId: 'client-missing',
    });
    expect(delivery).toEqual({ outcome: 'failed' });
  });
  return hook;
}

function renderFailedTurn() {
  const projection = projectTurns(useSessionStore.getState().messages, SESSION_ID, false);
  return render(<TurnBasedTraceView projection={projection} />);
}

describe('source_missing send failure vs not_trusted confirm card', () => {
  it.each(['zh', 'en'] as const)('source_missing shows the missing-folder sentence and only the reselect button in %s', async (language) => {
    await sendAndFail(language, trustError('source_missing', 'weekly-notes'));
    const copy = languages[language].turnCard.projectTrustConfirm;
    const sentence = copy.reasons.source_missing.replace('{name}', 'weekly-notes');
    const { container } = renderFailedTurn();
    expect(screen.getAllByText(sentence)).toHaveLength(1);
    expect(screen.getByRole('button', { name: copy.reselect })).toBeTruthy();
    expect(screen.queryByRole('button', { name: copy.button })).toBeNull();
    const text = container.textContent ?? '';
    expect(text).not.toContain('确认并重发');
    expect(text).not.toContain('需要你确认');
    expect(text).not.toContain('Confirm and resend');
    expect(text).not.toContain('needs your confirmation');
    expect(useTaskStore.getState().sessionStates[SESSION_ID]?.status).toBe('idle');
    expect(useSessionStore.getState().messages.find((message) => message.role === 'assistant')?.metadata).toMatchObject({
      sendFailureCode: 'PROJECT_SOURCE_TRUST',
      sendFailureKind: 'source_missing',
      sendFailureFolderName: 'weekly-notes',
    });
  });

  it('not_trusted still shows the confirm card and marks the session as an error', async () => {
    await sendAndFail('zh', trustError('not_trusted'));
    renderFailedTurn();
    expect(screen.getByText('这个项目文件夹需要你确认后 Neo 才能使用。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认并重发' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重新选择文件夹' })).toBeNull();
    expect(useTaskStore.getState().sessionStates[SESSION_ID]?.status).toBe('error');
  });

  it('reselect then save still confirms and resends the original message', async () => {
    const hook = await sendAndFail('zh', trustError('source_missing', 'weekly-notes'));
    let accepted!: Promise<unknown>;
    useMessageActionStore.getState().register((content, context) => {
      accepted = hook.result.current.sendMessage({ content, sessionId: SESSION_ID, ...context });
    }, () => useSessionStore.getState().messages);
    confirmMock.mockResolvedValueOnce({ confirmed: true });
    invokeMock.mockResolvedValueOnce(undefined);
    renderFailedTurn();
    fireEvent.click(screen.getByRole('button', { name: '重新选择文件夹' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存文件夹' }));
    });
    await act(async () => { await accepted; });
    expect(confirmMock).toHaveBeenCalledWith('project:confirm-source-trust', { sessionId: SESSION_ID });
    expect(invokeMock).toHaveBeenLastCalledWith('agent:send-message', expect.objectContaining({
      clientMessageId: 'client-missing',
      sessionId: SESSION_ID,
      content: PROMPT,
    }));
  });
});
