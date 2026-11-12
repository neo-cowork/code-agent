// @vitest-environment jsdom
// ============================================================================
// N-MEDIA-GEN-MUSIC-FALLBACK-FU1：delegate_task 回执行的终局工具失败出路。
// 主人决策（10-24 option 2）：后台任务收尾失败 / 模型放弃时，任务行要说清失败
// code 的中文摘要 + 出路。这里钉 DelegationReceipt：失败/带字段的 completed 亮
// 出路（含 {alternatives} 填充），运行中与无字段任务不亮。
// ============================================================================

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';
import type { AgentTreeNode } from '../../../src/shared/contract/agentTree';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { ToolCall } from '../../../src/shared/contract';

let language: 'zh' | 'en' = 'zh';
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: language === 'zh' ? zh : en }) }));

const openPreview = vi.fn();
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(
    (selector: (state: { openPreview: typeof openPreview }) => unknown) => selector({ openPreview }),
    { getState: () => ({ language }) },
  ),
}));

import { DelegationHeader, DelegationReceipt } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/DelegationReceipt';
import { deriveDelegationPresentation } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';

const delegateCall: ToolCall = {
  id: 'call-delegate-1',
  name: 'delegate_task',
  arguments: { task: '给视频配背景音乐' },
  result: { toolCallId: 'call-delegate-1', success: true, output: '已派出任务 task-music' },
};

function musicTask(status: Task['status'], withFailure: boolean): Task {
  return {
    id: 'task-music',
    toolCallId: 'call-delegate-1',
    sessionId: 'session-1',
    source: 'delegate_task',
    title: '给视频配背景音乐',
    summary: '音乐生成失败，视频先交付了',
    status,
    createdAt: 1,
    updatedAt: 2,
    events: [],
    outputRefs: [],
    ...(withFailure
      ? {
        progress: {
          lastToolStep: { tool: 'music_generate', at: 2 },
          lastToolFailure: {
            tool: 'music_generate',
            code: 'MUSIC_SERVICE_UNAVAILABLE',
            alternatives: 'zhipu:glm-5.3',
            at: 2,
          },
        },
      }
      : {}),
  };
}

function renderReceipt(task: Task): void {
  const presentation = deriveDelegationPresentation(delegateCall, [task], []);
  expect(presentation).not.toBeNull();
  render(<DelegationReceipt presentation={presentation!} />);
}

afterEach(() => { cleanup(); language = 'zh'; });

describe('DelegationReceipt — 终局工具失败出路', () => {
  it('失败任务的回执行亮中文摘要 + 出路，{alternatives} 已填', () => {
    renderReceipt(musicTask('failed', true));
    const note = screen.getByTestId('delegation-tool-failure');
    expect(note.textContent).toContain('默认音乐服务（MiniMax）已不可用');
    expect(note.textContent).toContain('可改用已配置的音乐模型：zhipu:glm-5.3');
  });

  it('模型放弃但任务 completed：字段仍在就亮出路', () => {
    renderReceipt(musicTask('completed', true));
    expect(screen.getByTestId('delegation-tool-failure').textContent)
      .toContain('可改用已配置的音乐模型：zhipu:glm-5.3');
  });

  it('运行中的任务走 activity 行，不亮出路', () => {
    renderReceipt(musicTask('running', true));
    expect(screen.getByTestId('delegation-activity')).toBeTruthy();
    expect(screen.queryByTestId('delegation-tool-failure')).toBeNull();
  });

  it('无 lastToolFailure 的终态任务回执不变：没有出路行', () => {
    renderReceipt(musicTask('failed', false));
    expect(screen.queryByTestId('delegation-tool-failure')).toBeNull();
    expect(screen.getByTestId('delegation-failure').textContent).toContain('音乐生成失败，视频先交付了');
  });
});

// Pinned before changing the display edge: all 15 codes and the two raw fallbacks.
const chineseReasons = [
  '当前角色不允许这一步', '需要的权限没有通过', '所需能力当前不可用',
  '助手设置的等待时间超过了允许的上限，需要缩短', '这次任务的额度已经用完',
  '处理时间超过了限制', '上级任务已经结束', '已按你的操作取消', '上级任务已取消这一步',
  '前置步骤没有完成', '还缺少必要的前置条件', '这一阶段没有完成',
  '无法为这次任务准备运行环境', '模型没有给出可用结果', '失败原因还不明确',
];
const backgroundCall: ToolCall = {
  id: 'spawn-suppliers', name: 'spawn_agent', arguments: { task: 'Compare three suppliers' },
  result: { toolCallId: 'spawn-suppliers', success: true, metadata: { agentId: 'background-suppliers' } },
};
function backgroundNode(code?: AgentFailureCode): AgentTreeNode {
  return {
    id: 'execution-suppliers', backgroundAgentId: 'background-suppliers', role: 'background', background: true,
    status: 'failed', statusLabel: '遇到问题', failureCode: code, failureReason: '父任务已经结束',
    children: [], worktreeState: { status: 'none' }, budgetSummary: {}, evidenceRefs: [], sources: ['backgroundRegistry'],
  };
}
describe.each(['en', 'zh'] as const)('background card display edge in %s', (locale) => {
  it.each(Object.values(AgentFailureCode))('renders the header and receipt for %s', (code) => {
    language = locale;
    const t = locale === 'en' ? en : zh;
    const presentation = deriveDelegationPresentation(backgroundCall, [], [backgroundNode(code)], t)!;
    const { container } = render(<><DelegationHeader presentation={presentation} /><DelegationReceipt presentation={presentation} /></>);
    if (locale === 'en') {
      expect(container.textContent).not.toMatch(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u);
      expect(container.textContent).toContain("Background assistant didn't finish");
      expect(container.textContent).not.toContain('Not completed background');
    } else {
      expect(container.firstChild?.textContent).toBe('执行失败助手');
      expect(screen.getByTestId('delegation-failure').textContent).toBe(chineseReasons[Object.values(AgentFailureCode).indexOf(code)]);
    }
  });

  it.each(['父任务已经结束', '未登记的主机错误', undefined])('localizes missing-code failure %s without changing Chinese copy', (reason) => {
    language = locale;
    const t = locale === 'en' ? en : zh;
    const source = { ...backgroundNode(), failureReason: reason, progress: '处理进度已经中断' };
    const presentation = deriveDelegationPresentation(backgroundCall, [], [source], t)!;
    render(<DelegationReceipt presentation={presentation} />);
    expect(screen.getByTestId('delegation-failure').textContent).toBe(locale === 'zh'
      ? reason || source.progress
      : reason === '父任务已经结束' ? 'The parent task has already ended' : 'The cause of the failure is not yet known');
  });

  it.each(['working', 'completed', 'failed'] as const)('uses a complete %s headline and preserves Chinese bytes', (state) => {
    language = locale;
    const presentation = { state, title: locale === 'en' ? 'Background assistant' : '助手', outputs: [], activityIds: [] };
    const { container } = render(<DelegationHeader presentation={presentation} />);
    expect(container.textContent).toBe(locale === 'en'
      ? { working: 'Background assistant is working', completed: 'Background assistant finished', failed: "Background assistant didn't finish" }[state]
      : { working: '代理工作中助手', completed: '已完成助手', failed: '执行失败助手' }[state]);
  });
});

describe.each(['en', 'zh'] as const)('task ledger display edge in %s', (locale) => {
  it.each(['父任务已经结束', '任务失败，耗时 2 分钟，日志 /tmp/task.log', undefined])('renders an uncoded task summary %s', (reason) => {
    language = locale;
    const t = locale === 'en' ? en : zh;
    const task = { ...musicTask('failed', false), title: '供应商对比', summary: reason };
    const presentation = deriveDelegationPresentation(delegateCall, [task], [], t)!;
    const { container } = render(<><DelegationHeader presentation={presentation} /><DelegationReceipt presentation={presentation} /></>);
    if (locale === 'en') {
      expect(container.textContent).not.toMatch(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u);
      expect(container.textContent).not.toContain('/tmp/task.log');
      expect(screen.getByTestId('delegation-failure').textContent).toBe(reason === '父任务已经结束'
        ? 'The parent task has already ended' : 'The cause of the failure is not yet known');
    } else if (reason) {
      expect(screen.getByTestId('delegation-failure').textContent).toBe(reason);
    } else {
      expect(screen.queryByTestId('delegation-failure')).toBeNull();
    }
  });
});


describe('uncoded English background task details', () => {
  it.each(['node reason', 'node progress', 'task failure', 'task summary'] as const)('preserves meaningful English through %s', (source) => {
    language = 'en';
    for (const reason of ['Original task reason', 'The supplier portal timed out after accepting the draft', '  The source document is locked  ']) {
      const node = { ...backgroundNode(), failureReason: source === 'node reason' ? reason : undefined, progress: reason };
      const task = { ...musicTask('failed', false), title: 'Compare supplier pricing', summary: reason,
        ...(source === 'task failure' ? { failure: { message: reason } } : {}),
      };
      const presentation = source.startsWith('node')
        ? deriveDelegationPresentation(backgroundCall, [], [node], en)!
        : deriveDelegationPresentation(delegateCall, [task], [], en)!;
      const view = render(<DelegationReceipt presentation={presentation} />);
      expect(view.getByTestId('delegation-failure').textContent).toBe(reason);
      view.unmount();
    }
  });

  it.each(['running', 'completed', 'failed'] as const)('preserves distinct English task headlines when %s', (status) => {
    language = 'en';
    const titles = ['Compare supplier pricing', 'Summarize meeting notes'];
    const presentations = titles.map((title) => deriveDelegationPresentation(delegateCall, [
      { ...musicTask(status, false), title },
    ], [], en)!);
    const { container } = render(<>{presentations.map((presentation) => (
      <DelegationHeader key={presentation.title} presentation={presentation} />
    ))}</>);
    const suffix = { running: ' is working', completed: ' finished', failed: " didn't finish" }[status];
    expect(screen.getAllByTestId('delegation-headline').map((header) => header.textContent)).toEqual(titles.map((title) => title + suffix));
    expect(container.textContent).not.toContain('Background assistant');
  });
});
