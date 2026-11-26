// @vitest-environment jsdom
// N-FIX-COMPOSER-TEXT-WHILE-QUESTION-CARD-OPEN-QUEUED 返修 r1：提问卡片打开时，
// composer 的 Enter 是作答（单问题）或拦下提示（多问题），占位必须说清这件事，
// 不能再写「Enter 排队」把用户往排队路径上带。入口：渲染整棵 ChatInput 看 placeholder span。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '../../../src/renderer/components/features/chat/ChatInput';
import type { UserQuestionRequest } from '../../../src/shared/contract';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import ipcService from '../../../src/renderer/services/ipcService';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

const SESSION = 'session-q-placeholder';

function makeSession(): SessionWithMeta {
  return {
    title: SESSION,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
    id: SESSION,
  } as SessionWithMeta;
}

function question(overrides: Partial<UserQuestionRequest['questions'][number]> = {}): UserQuestionRequest['questions'][number] {
  return {
    question: '8:30 已过，明晚还是换时间？',
    header: '时间',
    options: [{ label: '明晚', description: '' }, { label: '换时间', description: '' }],
    ...overrides,
  };
}

beforeEach(() => {
  useBundledCapabilityStore.setState({
    installed: { 'builtin.voice-live': false, 'builtin.voice-input': false },
    states: [],
    loaded: true,
    error: null,
  });
  const invokeDomain = ipcService.invokeDomain.bind(ipcService);
  vi.spyOn(ipcService, 'invokeDomain').mockImplementation((domain, action, payload) => {
    if (domain === IPC_DOMAINS.QUEUED_INPUT && action === 'list') return Promise.resolve([]);
    return invokeDomain(domain, action, payload);
  });
  useSessionStore.setState({
    sessions: [makeSession()],
    currentSessionId: SESSION,
    messages: [],
    pendingUserQuestionsBySessionId: new Map(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useSessionStore.setState({ sessions: [], currentSessionId: null, messages: [], pendingUserQuestionsBySessionId: new Map() });
});

describe('提问卡片打开时的 composer 占位', () => {
  it('单问题卡片：占位改口为「直接输入你的回答，Enter 提交」，不再说「Enter 排队」', () => {
    useSessionStore.getState().addPendingUserQuestion({
      id: 'q-1', sessionId: SESSION, questions: [question()], timestamp: 1,
    });
    render(<ChatInput onSend={() => true} isProcessing />);

    expect(screen.getByText('直接输入你的回答，Enter 提交给上面的提问')).toBeTruthy();
    expect(screen.queryByText('继续描述…（Enter 排队，⌘/Ctrl+Enter 改道）')).toBeNull();
  });

  it('多问题卡片：占位引导回卡片作答（与拦下提示同一句话）', () => {
    useSessionStore.getState().addPendingUserQuestion({
      id: 'q-2', sessionId: SESSION, questions: [question({ header: 'a' }), question({ header: 'b' })], timestamp: 1,
    });
    render(<ChatInput onSend={() => true} isProcessing />);

    expect(screen.getByText('上面的提问还在等你：点选一个选项，或在「其他」里写下答案。')).toBeTruthy();
    expect(screen.queryByText('继续描述…（Enter 排队，⌘/Ctrl+Enter 改道）')).toBeNull();
  });

  it('没有待答卡片：处理中占位仍是「Enter 排队」原文（不回归）', () => {
    render(<ChatInput onSend={() => true} isProcessing />);

    expect(screen.getByText('继续描述…（Enter 排队，⌘/Ctrl+Enter 改道）')).toBeTruthy();
  });
});
