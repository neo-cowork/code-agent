// @vitest-environment jsdom
//
// FB-1545：草稿恢复后（存档放回 / 发送失败回滚），不点任何地方直接回车，
// 必须和点发送按钮走同一条提交路径。点「放回输入框」会让焦点留在随即卸载的
// 提示条按钮上，回车到不了编辑区——只剩鼠标点发送能发。
// 走真实 ChatInput + 真实 composerDraft store/putBack，不手搓草稿 hook。

import React, { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import { composerDraftStorageKey } from '../../../src/renderer/components/features/chat/ChatInput/composerDraftStore';

const toastSpy = vi.hoisted(() => ({
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  show: vi.fn(),
}));

vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: toastSpy }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

import { ChatInput, type ChatInputHandle } from '../../../src/renderer/components/features/chat/ChatInput';
import ipcService from '../../../src/renderer/services/ipcService';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

const realCreateSession = useSessionStore.getState().createSession;

function makeSession(id: string): SessionWithMeta {
  return {
    id,
    title: id,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
  } as SessionWithMeta;
}

function showSession(session: SessionWithMeta): void {
  useSessionStore.setState({
    sessions: [session],
    currentSessionId: session.id,
    messages: [],
    createSession: realCreateSession,
  });
}

function resetCapabilityStore(): void {
  useBundledCapabilityStore.setState({
    installed: { 'builtin.voice-live': false, 'builtin.voice-input': false },
    states: [],
    loaded: true,
    error: null,
  });
}


const SESSION_ID = 'session-restore';
const STORED = '把本周会议纪要整理成三条要点';

function typeDraft(ref: React.RefObject<ChatInputHandle | null>, content: string): void {
  act(() => { ref.current!.setDraft({ content }); });
}

function clickSend(): void {
  fireEvent.click(screen.getByRole('button', { name: zh.chatInput.sendAria }));
}

function editorText(): string {
  return screen.getByTestId('chat-composer-textarea').textContent ?? '';
}

/** 真实键盘：回车落在当前焦点元素上（焦点在 body 就落在 body），不直接打到编辑区 */
function pressReturnOnActiveElement(): void {
  const target = document.activeElement ?? document.body;
  fireEvent.keyDown(target, { key: 'Enter', code: 'Enter', keyCode: 13 });
}

/** 真实点击会先把焦点移到被点的按钮，fireEvent.click 不会，手动补上 */
function realClick(el: HTMLElement): void {
  act(() => { el.focus(); });
  fireEvent.click(el);
}

beforeEach(() => {
  localStorage.clear();
  showSession(makeSession(SESSION_ID));
  vi.spyOn(ipcService, 'invokeDomain').mockImplementation((domain: string, action: string) => {
    if (domain === IPC_DOMAINS.QUEUED_INPUT && action === 'list') return Promise.resolve([]);
    return Promise.reject(new Error('no bridge'));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  useSessionStore.setState({ sessions: [], currentSessionId: null, messages: [] });
  resetCapabilityStore();
});

describe('恢复草稿后回车 = 点发送（FB-1545）', () => {
  it('路径 A：存档「放回输入框」后直接回车，发出一次，参数与点发送一致', async () => {
    localStorage.setItem(composerDraftStorageKey(SESSION_ID, false)!, JSON.stringify({ v: 2, text: STORED, attachments: [] }));
    const onSend = vi.fn(async (_e: ConversationEnvelope) => true);
    render(<ChatInput onSend={onSend} />);
    const notice = screen.getByTestId('unsent-draft-notice');
    expect(notice).toBeTruthy();
    realClick(screen.getByTestId('unsent-draft-put-back'));
    expect(screen.queryByTestId('unsent-draft-notice')).toBeNull();
    await waitFor(() => expect(editorText()).toBe(STORED));
    expect(document.activeElement).toBe(screen.getByTestId('chat-composer-textarea'));
    await act(async () => { pressReturnOnActiveElement(); });
    expect(onSend).toHaveBeenCalledTimes(1);
    const viaReturn = onSend.mock.calls[0][0];

    // 同一份存档，改点发送按钮，参数必须一致
    cleanup();
    localStorage.setItem(composerDraftStorageKey(SESSION_ID, false)!, JSON.stringify({ v: 2, text: STORED, attachments: [] }));
    const onSend2 = vi.fn(async (_e: ConversationEnvelope) => true);
    render(<ChatInput onSend={onSend2} />);
    realClick(screen.getByTestId('unsent-draft-put-back'));
    await waitFor(() => expect(editorText()).toBe(STORED));
    await act(async () => { clickSend(); });
    expect(onSend2).toHaveBeenCalledTimes(1);
    const strip = (e: ConversationEnvelope) => ({ ...e, clientMessageId: undefined });
    expect(strip(viaReturn)).toEqual(strip(onSend2.mock.calls[0][0]));
  });

  it('路径 B：发送失败回滚草稿后直接回车，第二次发出', async () => {
    const onSend = vi.fn(async (_e: ConversationEnvelope) => false);
    const ref = createRef<ChatInputHandle>();
    render(<ChatInput ref={ref} onSend={onSend} />);
    typeDraft(ref, STORED);
    await waitFor(() => expect(editorText()).toBe(STORED));
    await act(async () => { clickSend(); });
    expect(onSend).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(editorText()).toBe(STORED));
    expect(document.activeElement).toBe(screen.getByTestId('chat-composer-textarea'));
    await act(async () => { pressReturnOnActiveElement(); });
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('探查：输入法组合未结束（只有 compositionstart）时回车被吞——恢复流程不会制造这个状态', async () => {
    const onSend = vi.fn(async (_e: ConversationEnvelope) => true);
    const ref = createRef<ChatInputHandle>();
    render(<ChatInput ref={ref} onSend={onSend} />);
    typeDraft(ref, STORED);
    await waitFor(() => expect(editorText()).toBe(STORED));
    const editor = screen.getByTestId('chat-composer-textarea');
    fireEvent.compositionStart(editor);
    fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenCalledTimes(0);
  });
});
