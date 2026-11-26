// @vitest-environment jsdom
//
// N-FIX-EN-SUGGESTION-CHIPS-STILL-ZH 返修 r1（PR#4006 I1）：回复后的跟进建议芯片走的是全局
// agent:event 广播（收线后补播、镜像轮、别的窗口都一样）。芯片属于事件里的那个会话：停在别的
// 会话上的输入框不能收，切换会话也要清掉。否则 A 会话的跟进建议会出现在 B 的输入框里，
// 点一下就把与 B 无关的指令发进 B。入口：渲染整棵 ChatInput，往它注册的 agent:event 监听器投事件。

import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '../../../src/renderer/components/features/chat/ChatInput';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../../src/shared/ipc';
import ipcService from '../../../src/renderer/services/ipcService';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

const SESSION_A = 'session-chips-a';
const SESSION_B = 'session-chips-b';
const FIRST_CHIP = '把完整总结发给我';
const SECOND_CHIP = '列出三个要点';
const CHIPS = [
  { id: 'ctx-0', text: FIRST_CHIP, source: 'context' },
  { id: 'ctx-1', text: SECOND_CHIP, source: 'context' },
];

type AgentEventListener = (event: {
  type: string;
  data: unknown;
  streamEpoch: string;
  sessionId: string;
  seq: number;
}) => void;

let agentEventListeners: AgentEventListener[] = [];

function makeSession(id: string): SessionWithMeta {
  return {
    id,
    title: id,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    turnCount: 1,
    status: 'completed',
  } as SessionWithMeta;
}

function showSession(currentSessionId: string): void {
  useSessionStore.setState({
    sessions: [makeSession(SESSION_A), makeSession(SESSION_B)],
    currentSessionId,
    messages: [],
  });
}

/** 宿主广播的样子：带会话身份的 agent:event 信封（收线后补播走的就是这个形状）。 */
function pushFollowUpChips(sessionId: string): void {
  const event = {
    type: 'suggestions_update',
    data: CHIPS,
    streamEpoch: 'http:test-epoch',
    sessionId,
    seq: 200,
  };
  act(() => {
    for (const listener of agentEventListeners) listener(event);
  });
}

function chipCount(): number {
  return [FIRST_CHIP, SECOND_CHIP]
    .map((text) => screen.queryAllByText(text).length)
    .reduce((total, count) => total + count, 0);
}

beforeEach(() => {
  agentEventListeners = [];
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
  vi.spyOn(ipcService, 'on').mockImplementation((channel, callback) => {
    if (channel === IPC_CHANNELS.AGENT_EVENT) {
      agentEventListeners.push(callback as AgentEventListener);
    }
    return () => {};
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useSessionStore.setState({ sessions: [], currentSessionId: null, messages: [] });
});

describe('跟进建议芯片只属于它所在会话的输入框', () => {
  it('注册了 agent:event 监听器（否则下面的断言是空转）', () => {
    showSession(SESSION_A);
    render(<ChatInput onSend={() => true} />);

    expect(agentEventListeners.length).toBeGreaterThan(0);
  });

  it('当前会话的芯片照常显示', () => {
    showSession(SESSION_A);
    render(<ChatInput onSend={() => true} />);

    pushFollowUpChips(SESSION_A);

    expect(screen.getByText(FIRST_CHIP)).toBeTruthy();
    expect(screen.getByText(SECOND_CHIP)).toBeTruthy();
  });

  it('停在会话 A 时收到会话 B 的芯片：A 的输入框不显示；随后 A 自己的芯片照常显示', () => {
    showSession(SESSION_A);
    render(<ChatInput onSend={() => true} />);

    pushFollowUpChips(SESSION_B);

    expect(chipCount()).toBe(0);

    pushFollowUpChips(SESSION_A);

    expect(screen.getByText(FIRST_CHIP)).toBeTruthy();
    expect(screen.getByText(SECOND_CHIP)).toBeTruthy();
  });

  it('A 回复结束时用户已切到 B：A 的收线补播不落进 B，切回来也不翻出旧芯片', () => {
    showSession(SESSION_A);
    render(<ChatInput onSend={() => true} />);
    pushFollowUpChips(SESSION_A);
    expect(screen.getByText(FIRST_CHIP)).toBeTruthy();

    act(() => {
      useSessionStore.setState({ currentSessionId: SESSION_B });
    });

    // 切换会话：上一个会话的芯片不留在新会话的输入框里
    expect(chipCount()).toBe(0);

    // A 的补播晚到：页面此刻停在 B
    pushFollowUpChips(SESSION_A);
    expect(chipCount()).toBe(0);

    act(() => {
      useSessionStore.setState({ currentSessionId: SESSION_A });
    });

    expect(chipCount()).toBe(0);
  });

  it('停在 B 时 A 的补播被拦下后，B 自己的芯片仍能显示（拦截不是把输入框弄哑了）', () => {
    showSession(SESSION_B);
    render(<ChatInput onSend={() => true} />);

    pushFollowUpChips(SESSION_A);
    expect(chipCount()).toBe(0);

    pushFollowUpChips(SESSION_B);

    expect(screen.getByText(FIRST_CHIP)).toBeTruthy();
    expect(screen.getByText(SECOND_CHIP)).toBeTruthy();
  });
});
