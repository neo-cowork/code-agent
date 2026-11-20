// @vitest-environment jsdom
//
// 提问卡片打开时 composer 提交的路由（入口：useChatInputSubmit.handleSubmit）：
// 单问题 + 纯文本 → 当卡片答案；多问题/带附件 → 提示拦下；都不入队；无卡片 → 照常入队。
import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import type { UserQuestionRequest } from '../../../src/shared/contract';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

const toastMock = vi.hoisted(() => ({ warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: toastMock }));

import {
  useChatInputSubmit,
  type UseChatInputSubmitParams,
} from '../../../src/renderer/components/features/chat/ChatInput/useChatInputSubmit';
import { UserQuestionCard } from '../../../src/renderer/components/UserQuestionCard';
import ipcService from '../../../src/renderer/services/ipcService';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { zh } from '../../../src/renderer/i18n/zh';

const SESSION = 'session-q';

function makeParams(overrides: Partial<UseChatInputSubmitParams> = {}): UseChatInputSubmitParams {
  return {
    value: '明晚',
    attachments: [],
    voiceInputContext: null,
    pendingAppshot: null,
    pendingPromptCommand: null,
    pendingAgentSelection: null,
    currentSessionId: SESSION,
    isProcessing: true,
    disabled: true,
    isUploading: false,
    onSend: vi.fn().mockResolvedValue(true),
    onSteer: vi.fn().mockResolvedValue({ outcome: 'steered' }),
    agentEntries: [],
    buildEnvelope: (content, attachments): ConversationEnvelope => ({ content, attachments }),
    openAgentCommand: vi.fn(),
    addToInputHistory: vi.fn(),
    clearAppshot: vi.fn(),
    inputAreaRef: {
      current: { focus: vi.fn(), getEditor: () => null, getCaretOffset: () => 0, replaceRangeWithChip: vi.fn(), replaceRangeWithText: vi.fn() },
    },
    setValue: vi.fn(),
    setAttachments: vi.fn(),
    setVoiceInputContext: vi.fn(),
    setPendingPromptCommand: vi.fn(),
    setPendingAgentSelection: vi.fn(),
    setScheduleComposerOpen: vi.fn(),
    openGoalConfirm: vi.fn(),
    closeGoalConfirm: vi.fn(),
    openSeedComposer: vi.fn(),
    setActiveAgentId: vi.fn(),
    ...overrides,
  };
}

function request(overrides: Partial<UserQuestionRequest> = {}): UserQuestionRequest {
  return {
    id: 'q-1',
    sessionId: SESSION,
    questions: [{
      question: '8:30 已过，明晚还是换时间？',
      header: '时间',
      options: [{ label: '明晚', description: '' }, { label: '换时间', description: '' }],
    }],
    timestamp: 1,
    ...overrides,
  };
}

const domainInvoke = vi.fn();
let invokeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  domainInvoke.mockReset();
  domainInvoke.mockResolvedValue({ success: true, data: {} });
  window.codeAgentDomainAPI = { invoke: domainInvoke } as typeof window.codeAgentDomainAPI;
  invokeSpy = vi.spyOn(ipcService, 'invoke').mockResolvedValue(undefined as never);
  toastMock.warning.mockReset();
  useSessionStore.setState({ pendingUserQuestionsBySessionId: new Map() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const enqueueCalls = () => domainInvoke.mock.calls.filter((c) => c[1] === 'enqueue');
const responseCalls = () => invokeSpy.mock.calls.filter((c) => c[0] === IPC_CHANNELS.USER_QUESTION_RESPONSE);

async function submit(params: UseChatInputSubmitParams): Promise<void> {
  const { result } = renderHook(() => useChatInputSubmit(params));
  await act(async () => { await result.current.handleSubmit(); });
}

describe('composer 文字 × 提问卡片', () => {
  it('单问题卡片：文字作为该卡片答案，不入队，卡片出队', async () => {
    useSessionStore.getState().addPendingUserQuestion(request());
    const params = makeParams();
    await submit(params);

    expect(responseCalls()).toEqual([[IPC_CHANNELS.USER_QUESTION_RESPONSE, { requestId: 'q-1', answers: { 时间: '明晚' } }]]);
    expect(enqueueCalls()).toHaveLength(0);
    expect(params.onSend).not.toHaveBeenCalled();
    expect(useSessionStore.getState().getPendingUserQuestions(SESSION)).toHaveLength(0);
    expect(params.setValue).toHaveBeenCalledWith('');
  });

  it('多选问题：答案是含该文字的数组', async () => {
    useSessionStore.getState().addPendingUserQuestion(request({
      questions: [{ question: '选哪些？', header: '范围', multiSelect: true, options: [{ label: 'A', description: '' }] }],
    }));
    await submit(makeParams({ value: '都要' }));
    expect(responseCalls()[0]?.[1]).toEqual({ requestId: 'q-1', answers: { 范围: ['都要'] } });
    expect(enqueueCalls()).toHaveLength(0);
  });

  it('先在 composer 发文字、再点选项：只有一次回答，不产生新消息', async () => {
    const req = request();
    useSessionStore.getState().addPendingUserQuestion(req);
    const params = makeParams();
    await submit(params);
    expect(responseCalls()).toHaveLength(1);

    // 卡片已出队 → 再渲染卡片的人点不到选项；这里直接验证卡片不再 pending，且没有任何新发送
    expect(useSessionStore.getState().getPendingUserQuestions(SESSION)).toHaveLength(0);
    expect(enqueueCalls()).toHaveLength(0);
    expect(params.onSend).not.toHaveBeenCalled();
  });

  it('先在 composer 打字不发送、再点选项：文字不被偷发', async () => {
    const req = request();
    useSessionStore.getState().addPendingUserQuestion(req);
    render(<UserQuestionCard request={req} />);
    fireEvent.click(screen.getByText('明晚'));
    fireEvent.click(screen.getByRole('button', { name: zh.userQuestion.submit }));
    await waitFor(() => expect(responseCalls()).toHaveLength(1));
    expect(responseCalls()[0]?.[1]).toEqual({ requestId: 'q-1', answers: { 时间: '明晚' } });
    expect(enqueueCalls()).toHaveLength(0);
  });

  it('IPC 失败：返回 false 触发草稿回滚，卡片保留，不入队', async () => {
    useSessionStore.getState().addPendingUserQuestion(request());
    invokeSpy.mockRejectedValueOnce(new Error('boom'));
    const params = makeParams();
    await submit(params);
    expect(useSessionStore.getState().getPendingUserQuestions(SESSION)).toHaveLength(1);
    expect(enqueueCalls()).toHaveLength(0);
    expect(params.setValue).toHaveBeenLastCalledWith('明晚');
  });

  it('多问题卡片：拦下并提示，不入队、不回答，草稿保留', async () => {
    useSessionStore.getState().addPendingUserQuestion(request({
      questions: [
        { question: 'a?', header: 'a', options: [{ label: 'x', description: '' }] },
        { question: 'b?', header: 'b', options: [{ label: 'y', description: '' }] },
      ],
    }));
    const params = makeParams();
    await submit(params);
    expect(toastMock.warning).toHaveBeenCalledWith(zh.userQuestion.composerHint);
    expect(responseCalls()).toHaveLength(0);
    expect(enqueueCalls()).toHaveLength(0);
    expect(useSessionStore.getState().getPendingUserQuestions(SESSION)).toHaveLength(1);
    expect(params.setValue).toHaveBeenLastCalledWith('明晚');
  });

  it('单问题但带附件：同样拦下提示，不入队', async () => {
    useSessionStore.getState().addPendingUserQuestion(request());
    await submit(makeParams({
      attachments: [{ id: 'f1', type: 'file', category: 'text', name: 'a.txt', path: '/tmp/a.txt', size: 1, mimeType: 'text/plain' } as never],
    }));
    expect(toastMock.warning).toHaveBeenCalledWith(zh.userQuestion.composerHint);
    expect(responseCalls()).toHaveLength(0);
    expect(enqueueCalls()).toHaveLength(0);
  });

  it('没有待答卡片：照常入队，不碰提问通道', async () => {
    await submit(makeParams());
    expect(enqueueCalls()).toHaveLength(1);
    expect(responseCalls()).toHaveLength(0);
  });
});
