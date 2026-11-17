// @vitest-environment jsdom
//
// UserQuestionCard（G2 打断式选项卡）行为门：
// - 未作答时提交禁用；单选/多选/「其他」自由文本的回答回传形状与旧 Modal 一致；
// - 跳过只由按钮回传 declined；Esc 收起、←/→ 在多题向导切题；
// - 回答/跳过成功后从 pending 队列清除（composer 恢复）；IPC 失败不清除（可重试）。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { UserQuestionRequest } from '../../../src/shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invoke: invokeMock },
}));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: zh, language: 'zh' }),
}));

import { UserQuestionCard } from '../../../src/renderer/components/UserQuestionCard';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

function makeRequest(overrides: Partial<UserQuestionRequest> = {}): UserQuestionRequest {
  return {
    id: 'q-1',
    sessionId: 's1',
    questions: [
      {
        question: '选哪个方案？',
        header: '方案',
        options: [
          { label: 'A', description: 'a' },
          { label: 'B', description: 'b' },
        ],
      },
    ],
    timestamp: Date.now(),
    ...overrides,
  };
}

function pendingOf(sessionId: string) {
  return useSessionStore.getState().getPendingUserQuestions(sessionId);
}

function makeWizardRequest(): UserQuestionRequest {
  return makeRequest({
    questions: [
      {
        question: '第一题选哪个？',
        header: '第一题',
        options: [{ label: 'A', description: '第一个答案' }],
      },
      {
        question: '第二题选哪些？',
        header: '第二题',
        multiSelect: true,
        options: [{ label: 'B', description: '第二个答案' }],
      },
      {
        question: '第三题选哪个？',
        header: '第三题',
        options: [{ label: 'C', description: '第三个答案' }],
      },
    ],
  });
}

describe('UserQuestionCard（G2 打断式选项卡）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    useSessionStore.getState().clearPendingUserQuestionsForSession('s1');
  });

  it('未作答时提交禁用，选择后可提交', async () => {
    const request = makeRequest();
    useSessionStore.getState().addPendingUserQuestion(request);
    render(<UserQuestionCard request={request} />);

    const card = screen.getByTestId('user-question-card').firstElementChild;
    expect(card?.className).toContain('shadow-md');
    expect(card?.className).toContain('dark:shadow-2xl');
    const submit = screen.getByRole('button', { name: zh.userQuestion.submit });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText('A'));
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'q-1',
        answers: { 方案: 'A' },
      });
    });
    // 回答成功后卡片出队（composer 恢复）
    await waitFor(() => expect(pendingOf('s1')).toHaveLength(0));
  });

  it('三题按步展示：单选自动前进、回退保留答案、末步只显式提交一次', async () => {
    const request = makeWizardRequest();
    useSessionStore.getState().addPendingUserQuestion(request);
    render(<UserQuestionCard request={request} />);

    expect(screen.getByText('第一题选哪个？')).toBeTruthy();
    expect(screen.queryByText('第二题选哪些？')).toBeNull();
    expect(screen.getByText(zh.userQuestion.stepOf(1, 3))).toBeTruthy();
    const progress = screen.getByTestId('user-question-progress');
    const progressSegments = progress.querySelectorAll('[data-state]');
    expect(progressSegments).toHaveLength(3);
    expect(progressSegments[0].className).toContain('bg-mark-info');
    expect(progressSegments[1].className).toContain('bg-zinc-700');
    const firstNext = screen.getByRole('button', { name: zh.userQuestion.next });
    expect((firstNext as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /A/ }));
    await waitFor(() => expect(screen.getByText('第二题选哪些？')).toBeTruthy());
    expect(invokeMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: zh.userQuestion.back })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: zh.userQuestion.back }));
    const selectedA = screen.getByRole('button', { name: /A/ });
    expect(selectedA.className).toContain('border-badge-info');
    fireEvent.click(screen.getByRole('button', { name: zh.userQuestion.next }));

    fireEvent.click(screen.getByRole('button', { name: /B/ }));
    fireEvent.click(screen.getByText(zh.userQuestion.other));
    expect((screen.getByRole('button', { name: zh.userQuestion.next }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(zh.userQuestion.otherPlaceholder), {
      target: { value: '补充答案' },
    });
    fireEvent.click(screen.getByRole('button', { name: zh.userQuestion.next }));

    expect(screen.getByText('第三题选哪个？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /C/ }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: zh.userQuestion.next })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: zh.userQuestion.submit }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'q-1',
        answers: { 第一题: 'A', 第二题: ['B', '补充答案'], 第三题: 'C' },
      });
    });
  });

  it('Enter 执行当前主动作；首步仍保留下一步按钮', async () => {
    const request = makeWizardRequest();
    render(<UserQuestionCard request={request} />);

    fireEvent.click(screen.getByRole('button', { name: /A/ }));
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(screen.getByText('第二题选哪些？')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /B/ }));
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(screen.getByText('第三题选哪个？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /C/ }));
    fireEvent.keyDown(document, { key: 'Enter' });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
  });

  it('单题不显示进度、步数或导航按钮，只保留提交动作', () => {
    render(<UserQuestionCard request={makeRequest()} />);

    expect(screen.queryByTestId('user-question-progress')).toBeNull();
    expect(screen.queryByText(zh.userQuestion.stepOf(1, 1))).toBeNull();
    expect(screen.queryByRole('button', { name: zh.userQuestion.back })).toBeNull();
    expect(screen.queryByRole('button', { name: zh.userQuestion.next })).toBeNull();
    expect(screen.getByRole('button', { name: zh.userQuestion.submit })).toBeTruthy();
  });

  it.each([
    { label: '方案 A (推荐)' },
    { label: '方案 A', recommended: true },
  ])('推荐项 $label 解析为徽标并默认聚焦，但初始不选中', (recommendedOption) => {
    const request = makeRequest({
      questions: [{
        question: '选哪个方案？',
        header: '方案',
        options: [
          { ...recommendedOption, description: '推荐方案' },
          { label: '方案 B', description: '普通方案' },
        ],
      }],
    });

    render(<UserQuestionCard request={request} />);

    const recommended = screen.getByRole('button', { name: /方案 A.*推荐.*推荐方案/u });
    expect(screen.getByText(zh.userQuestion.recommended)).toBeTruthy();
    expect(screen.queryByText(/\(推荐\)/u)).toBeNull();
    expect(document.activeElement).toBe(recommended);
    expect(recommended.className).not.toContain('ring-1');
    expect((screen.getByRole('button', { name: zh.userQuestion.submit }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('单选「其他」自由文本 → 回传输入内容而非固定选项', async () => {
    useSessionStore.getState().addPendingUserQuestion(makeRequest());
    render(<UserQuestionCard request={makeRequest()} />);

    fireEvent.click(screen.getByText(zh.userQuestion.other));
    fireEvent.change(screen.getByPlaceholderText(zh.userQuestion.otherPlaceholder), {
      target: { value: '都不选，改成 C 方案' },
    });
    fireEvent.click(screen.getByRole('button', { name: zh.userQuestion.submit }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'q-1',
        answers: { 方案: '都不选，改成 C 方案' },
      });
    });
  });

  it('多选：预设选项 + 「其他」自由文本 → 数组同时包含两者', async () => {
    const request = makeRequest({
      questions: [
        {
          question: '需要哪些能力？',
          header: '能力',
          multiSelect: true,
          options: [
            { label: 'A', description: 'a' },
            { label: 'B', description: 'b' },
          ],
        },
      ],
    });
    useSessionStore.getState().addPendingUserQuestion(request);
    render(<UserQuestionCard request={request} />);

    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByText(zh.userQuestion.other));
    fireEvent.change(screen.getByPlaceholderText(zh.userQuestion.otherPlaceholder), {
      target: { value: '还需要导出功能' },
    });
    fireEvent.click(screen.getByRole('button', { name: zh.userQuestion.submit }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'q-1',
        answers: { 能力: ['A', '还需要导出功能'] },
      });
    });
  });

  it('跳过按钮：无原因 → declined 不携带 reason，卡片出队', async () => {
    const request = makeRequest();
    const onSkipped = vi.fn();
    useSessionStore.getState().addPendingUserQuestion(request);
    render(<UserQuestionCard request={request} onSkipped={onSkipped} />);

    fireEvent.click(screen.getByRole('button', { name: zh.userQuestion.skip }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'q-1',
        declined: true,
      });
    });
    expect(onSkipped).toHaveBeenCalledOnce();
    await waitFor(() => expect(pendingOf('s1')).toHaveLength(0));
  });

  it('跳过并填写原因 → declined 响应附带 reason', async () => {
    useSessionStore.getState().addPendingUserQuestion(makeRequest());
    render(<UserQuestionCard request={makeRequest()} />);

    fireEvent.change(screen.getByPlaceholderText(zh.userQuestion.declineReasonPlaceholder), {
      target: { value: '先去处理别的事' },
    });
    fireEvent.click(screen.getByRole('button', { name: zh.userQuestion.skip }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'q-1',
        declined: true,
        reason: '先去处理别的事',
      });
    });
  });

  it('Esc 收起且不发 skip，点迷你条或再按 Esc 展开', () => {
    useSessionStore.getState().addPendingUserQuestion(makeRequest());
    render(<UserQuestionCard request={makeRequest()} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('user-question-collapsed')).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('user-question-collapsed'));
    expect(screen.getByTestId('user-question-card')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('user-question-card')).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('←/→ 在多题向导切题，未作答时 → 无效，单题不绑定', () => {
    const view = render(<UserQuestionCard request={makeWizardRequest()} />);

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByText('第一题选哪个？')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /A/u }));
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByText('第二题选哪些？')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(screen.getByText('第一题选哪个？')).toBeTruthy();

    view.unmount();
    render(<UserQuestionCard request={makeRequest()} />);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByText('选哪个方案？')).toBeTruthy();
  });

  it('数字键 2 选中第二项，主按钮聚焦后 Enter 提交', async () => {
    const request = makeRequest();
    useSessionStore.getState().addPendingUserQuestion(request);
    render(<UserQuestionCard request={request} />);

    expect(screen.getByTestId('user-question-key-hint').textContent).toBe(zh.userQuestion.keyboardHint(3));
    expect(screen.getByTestId('user-question-digit-2').textContent).toBe('2');

    fireEvent.keyDown(document, { key: '2' });
    expect(screen.getByRole('button', { name: /B/ }).className).toContain('ring-1');
    expect(screen.getByRole('button', { name: /A/ }).className).not.toContain('ring-1');

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: zh.userQuestion.submit }));
    });
    fireEvent.keyDown(document, { key: 'Enter' });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
        requestId: 'q-1',
        answers: { 方案: 'B' },
      });
    });
  });

  it('焦点在「其他」输入框时按 1-N 不改选中', () => {
    render(<UserQuestionCard request={makeRequest()} />);

    fireEvent.click(screen.getByTestId('user-question-other-row'));
    const input = screen.getByPlaceholderText(zh.userQuestion.otherPlaceholder);
    input.focus();
    expect(document.activeElement).toBe(input);

    for (const key of ['1', '2', '3']) {
      fireEvent.keyDown(input, { key });
    }

    expect(screen.getByRole('button', { name: /A/ }).className).not.toContain('ring-1');
    expect(screen.getByRole('button', { name: /B/ }).className).not.toContain('ring-1');
    expect(screen.getByTestId('user-question-other-row').className).toContain('ring-1');
    expect(input).toBe(document.activeElement);
  });

  it('多选时数字键切换同一项，输入法组合期间不选中', () => {
    const request = makeRequest({
      questions: [{
        question: '需要哪些能力？',
        header: '能力',
        multiSelect: true,
        options: [
          { label: 'A', description: 'a' },
          { label: 'B', description: 'b' },
        ],
      }],
    });
    render(<UserQuestionCard request={request} />);

    fireEvent.keyDown(document, { key: '1' });
    expect(screen.getByRole('button', { name: /A/ }).className).toContain('ring-1');
    fireEvent.keyDown(document, { key: '1' });
    expect(screen.getByRole('button', { name: /A/ }).className).not.toContain('ring-1');

    const composing = new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true });
    Object.defineProperty(composing, 'isComposing', { get: () => true });
    window.dispatchEvent(composing);
    expect(screen.getByRole('button', { name: /B/ }).className).not.toContain('ring-1');
  });

  it('↑↓ 在选项行与「其他」之间移动焦点且到头停止，选项上的 Enter 不提交', () => {
    render(<UserQuestionCard request={makeRequest()} />);
    const optionA = screen.getByRole('button', { name: /A/ });
    const optionB = screen.getByRole('button', { name: /B/ });
    const other = screen.getByTestId('user-question-other-row');

    optionA.focus();
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(optionA.className).not.toContain('ring-1');
    expect(invokeMock).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(optionB);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(other);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(other);

    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(optionB);
    optionA.focus();
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(optionA);
  });

  it('「其他」只在下一个数字不超过 9 时占用数字键', () => {
    const eight = Array.from({ length: 8 }, (_, index) => ({
      label: `八项${index + 1}`,
      description: `说明${index + 1}`,
    }));
    const eightView = render(<UserQuestionCard request={makeRequest({
      questions: [{ question: '选哪个？', header: '选项', options: eight }],
    })} />);

    expect(screen.getByTestId('user-question-digit-9').textContent).toBe('9');
    fireEvent.keyDown(document, { key: '9' });
    expect(screen.getByTestId('user-question-other-row').className).toContain('ring-1');
    expect(screen.getByRole('button', { name: /八项8/ }).className).not.toContain('ring-1');

    eightView.unmount();
    const nine = Array.from({ length: 9 }, (_, index) => ({
      label: `九项${index + 1}`,
      description: `说明${index + 1}`,
    }));
    render(<UserQuestionCard request={makeRequest({
      questions: [{ question: '选哪个？', header: '选项', options: nine }],
    })} />);

    expect(screen.queryByTestId('user-question-digit-10')).toBeNull();
    expect(screen.getByTestId('user-question-key-hint').textContent).toBe(zh.userQuestion.keyboardHint(9));
    fireEvent.keyDown(document, { key: '9' });
    expect(screen.getByRole('button', { name: /九项9/ }).className).toContain('ring-1');
    expect(screen.getByTestId('user-question-other-row').className).not.toContain('ring-1');
  });

  it('IPC 失败不清队列（卡片留在原地可重试）', async () => {
    invokeMock.mockRejectedValue(new Error('ipc down'));
    const request = makeRequest();
    useSessionStore.getState().addPendingUserQuestion(request);
    render(<UserQuestionCard request={request} />);

    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByRole('button', { name: zh.userQuestion.submit }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    // 给清除动作一个（不应发生的）机会
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pendingOf('s1')).toHaveLength(1);
  });
});
