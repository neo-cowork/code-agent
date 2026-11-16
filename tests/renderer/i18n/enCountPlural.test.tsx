// @vitest-environment jsdom

// FB-1490 / N-FIX-EN-COUNT-PLURAL-IN-STEP-SUMMARY：英文 UI 的 "{count} <复数名词>"
// 文案在 count === 1 时必须是单数。运行中概要那条路（humanizeToolGroupLabel →
// toolStepHumanize.groupSingular）在 #3292 已修好，这里用四状态 × count 1/2 钉死；
// 其余路径走本单改的 { one, other } 对 + interpolatePlural。
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTreeSnapshot } from '../../../src/shared/contract/agentTree';
import type { Task } from '../../../src/shared/contract/backgroundTask';
import type { ToolCall } from '../../../src/shared/contract';

import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { permissionConsequence } from '../../../src/renderer/components/PermissionDialog/permissionPresentation';
import type { PermissionRequest } from '../../../src/renderer/components/PermissionDialog/types';
import { humanizeToolGroupLabel } from '../../../src/renderer/utils/humanizeToolStep';
import { interpolate, interpolatePlural } from '../../../src/renderer/i18n/interpolate';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { getSurfaceExecutionTranslations } from '../../../src/renderer/i18n/surfaceExecution';

const mocks = vi.hoisted(() => ({
  tasks: [] as Task[],
  snapshot: null as AgentTreeSnapshot | null,
  openPreview: vi.fn(),
  pendingPermissionRequest: null as PermissionRequest | null,
  pendingPermissionSessionId: null as string | null,
  queuedPermissionRequests: {} as Record<string, PermissionRequest[] | undefined>,
}));

vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (state: { tasks: Task[] }) => unknown) => selector({ tasks: mocks.tasks }),
}));

vi.mock('../../../src/renderer/hooks/useAgentTreeSnapshot', () => ({
  useAgentTreeSnapshot: () => ({ snapshot: mocks.snapshot, refresh: vi.fn() }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { currentSessionId: string }) => unknown) => (
    selector({ currentSessionId: 'session-1' })
  ),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign((selector?: (state: {
    processingSessionIds: Set<string>;
    openPreview: typeof mocks.openPreview;
    language: 'en';
    setLanguage: ReturnType<typeof vi.fn>;
    cloudUIStrings: undefined;
    pendingPermissionRequest: PermissionRequest | null;
    pendingPermissionSessionId: string | null;
    queuedPermissionRequests: Record<string, PermissionRequest[] | undefined>;
  }) => unknown) => {
    const state = {
      processingSessionIds: new Set<string>(),
      openPreview: mocks.openPreview,
      language: 'en' as const,
      setLanguage: vi.fn(),
      cloudUIStrings: undefined as undefined,
      pendingPermissionRequest: mocks.pendingPermissionRequest,
      pendingPermissionSessionId: mocks.pendingPermissionSessionId,
      queuedPermissionRequests: mocks.queuedPermissionRequests,
    };
    return selector ? selector(state) : state;
  }, { getState: () => ({ language: 'en' as const }) }),
}));

function delegateCall(): ToolCall {
  return {
    id: 'delegate-call-1',
    name: 'delegate_task',
    arguments: { description: 'review the checklist' },
    result: { toolCallId: 'delegate-call-1', success: true, output: 'accepted' },
  };
}

function task(progressCurrent: number): Task {
  return {
    id: 'task-1',
    source: 'session_command_center',
    sessionId: 'session-1',
    toolCallId: 'delegate-call-1',
    title: 'review the checklist',
    status: 'completed',
    createdAt: 1,
    updatedAt: 2,
    events: [],
    outputRefs: [],
    progress: {
      current: progressCurrent,
      total: progressCurrent,
      lastToolStep: { tool: 'Read', target: '/repo/notes-a.txt', toolIndex: 0, toolTotal: progressCurrent, at: 3 },
    },
  };
}

afterEach(cleanup);

beforeEach(() => {
  mocks.tasks = [];
  mocks.snapshot = null;
  mocks.openPreview.mockReset();
  mocks.pendingPermissionRequest = null;
  mocks.pendingPermissionSessionId = null;
  mocks.queuedPermissionRequests = {};
});

describe('humanizeToolGroupLabel (en) — singular branch at count 1, #3292 pinned', () => {
  const STATUSES = ['completed', 'failed', 'running', 'pending-approval'] as const;

  it.each(STATUSES)('%s: one step per bucket reads singular with ", " separator', (status) => {
    const label = humanizeToolGroupLabel(['Read', 'Bash'], en, status);
    expect(label).toContain('1 time');
    expect(label).toContain('1 command');
    expect(label).not.toMatch(/\b1 (steps|times|files)\b/);
    expect(label).not.toContain('、');
    expect(label).toContain(', ');
  });

  it('completed: probe line from the feedback ("Inspecting content 1 time, Running 1 command" is the running shape)', () => {
    expect(humanizeToolGroupLabel(['Read', 'Bash'], en, 'completed'))
      .toBe('Looked at content 1 time, Ran 1 command');
    expect(humanizeToolGroupLabel(['Read', 'Bash'], en, 'running'))
      .toBe('Inspecting content 1 time, Running 1 command');
    expect(humanizeToolGroupLabel(['Read', 'Bash'], en, 'failed'))
      .toBe('Could not inspect content 1 time, Could not run 1 command');
    expect(humanizeToolGroupLabel(['Read', 'Bash'], en, 'pending-approval'))
      .toBe('Request to inspect content 1 time, Request to run 1 command');
  });

  it.each(STATUSES)('%s: two steps per bucket keep the plural branch', (status) => {
    const label = humanizeToolGroupLabel(['Read', 'Read', 'Bash', 'Bash'], en, status);
    expect(label).toContain('2 times');
    expect(label).toContain('2 commands');
    expect(label).not.toContain('、');
    expect(label).toContain(', ');
  });

  it('zh: output at 1 and 2 unchanged (、 separator, no singular branch by design)', () => {
    expect(humanizeToolGroupLabel(['Read', 'Bash'], zh, 'completed'))
      .toBe('查看了 1 次内容、运行了 1 条命令');
    expect(humanizeToolGroupLabel(['Read', 'Read', 'Bash', 'Bash'], zh, 'completed'))
      .toBe('查看了 2 次内容、运行了 2 条命令');
  });
});

describe('DelegationReceipt (en) — completed card step count', () => {
  it('one step reads "Completed 1 step"', () => {
    mocks.tasks = [task(1)];
    const view = render(<ToolCallDisplay toolCall={delegateCall()} index={0} total={1} />);
    expect(view.getByTestId('delegation-receipt').textContent).toContain('Completed 1 step');
    expect(view.getByTestId('delegation-receipt').textContent).not.toContain('1 steps');
  });

  it('two steps read "Completed 2 steps"', () => {
    mocks.tasks = [task(2)];
    const view = render(<ToolCallDisplay toolCall={delegateCall()} index={0} total={1} />);
    expect(view.getByTestId('delegation-receipt').textContent).toContain('Completed 2 steps');
  });
});

describe('permission consequence (en) — delete file count', () => {
  const consequence = (details: PermissionRequest['details']) => permissionConsequence(
    {
      id: 'permission-test',
      sessionId: 'session-test',
      tool: 'file_delete',
      type: 'file_delete',
      details,
    },
    en,
  );

  it('single-file delete (file_delete + affectedPath) reads "(1 file)"', () => {
    expect(consequence({ affectedPath: 'old-draft.txt' }))
      .toBe('Permanently deletes old-draft.txt (1 file) without using Trash.');
  });

  it('two files read "(2 files)", zero reads "(0 files)"', () => {
    expect(consequence({ affectedPath: 'old-draft.txt', affectedFileCount: 2 }))
      .toBe('Permanently deletes old-draft.txt (2 files) without using Trash.');
    expect(consequence({ affectedPath: 'old-draft.txt', affectedFileCount: 0 }))
      .toBe('Permanently deletes old-draft.txt (0 files) without using Trash.');
  });

  it('zh output unchanged（单文件也是「（约 1 个文件）」）', () => {
    expect(permissionConsequence(
      { id: 'p', sessionId: 's', tool: 'file_delete', type: 'file_delete', details: { affectedPath: 'old-draft.txt' } },
      zh,
    )).toBe('将永久删除 old-draft.txt（约 1 个文件），不进回收站。');
  });
});

describe('{ one, other } templates rendered with interpolatePlural (en 0/1/2, zh unchanged)', () => {
  it('trace steps', () => {
    expect(interpolatePlural(en.decisionCard.permission.traceSteps, 1)).toBe('1 step');
    expect(interpolatePlural(en.decisionCard.permission.traceSteps, 2)).toBe('2 steps');
    expect(interpolatePlural(en.decisionCard.permission.traceSteps, 0)).toBe('0 steps');
    expect(interpolatePlural(zh.decisionCard.permission.traceSteps, 1)).toBe('1 步');
    expect(interpolatePlural(zh.decisionCard.permission.traceSteps, 2)).toBe('2 步');
  });

  it('plan approval step count and approved summary', () => {
    expect(interpolatePlural(en.planApproval.stepCount, 1)).toBe('1 step');
    expect(interpolatePlural(en.planApproval.stepCount, 2)).toBe('2 steps');
    expect(interpolatePlural(en.planApproval.approvedSummary, 1)).toBe('Plan · Allowed · 1 step');
    expect(interpolatePlural(en.planApproval.approvedSummary, 2)).toBe('Plan · Allowed · 2 steps');
    expect(interpolatePlural(zh.planApproval.stepCount, 1)).toBe('共 1 步');
    expect(interpolatePlural(zh.planApproval.approvedSummary, 2)).toBe('计划 · 已允许 · 2 步');
  });

  it('attachment counts (pages / archive files / entries / dangerous paths / folder / collapse)', () => {
    expect(interpolatePlural(en.attachmentPreview.pageCount, 1)).toBe('1 page');
    expect(interpolatePlural(en.attachmentPreview.pageCount, 2)).toBe('2 pages');
    expect(interpolatePlural(en.attachmentPreview.archiveFilesCount, 1)).toBe('1 file');
    expect(interpolatePlural(en.attachmentPreview.archiveFilesCount, 2)).toBe('2 files');
    expect(interpolatePlural(en.attachmentPreview.archiveEntriesCount, 1)).toBe('1 entry listed');
    expect(interpolatePlural(en.attachmentPreview.archiveEntriesCount, 2)).toBe('2 entries listed');
    expect(interpolatePlural(en.attachmentPreview.dangerousPathsCount, 1)).toBe('1 suspicious path');
    expect(interpolatePlural(en.attachmentPreview.folderFilesCount, 1)).toBe('📎 1 file');
    expect(interpolatePlural(en.attachmentPreview.collapseFilesCount, 2)).toBe('Collapse 2 files');
    expect(interpolatePlural(zh.attachmentPreview.pageCount, 1)).toBe('1 页');
    expect(interpolatePlural(zh.attachmentPreview.folderFilesCount, 2)).toBe('📎 2 个文件');
  });

  it('compaction and tool-result counts', () => {
    expect(interpolatePlural(en.chat.compactionCountBadge, 1)).toBe('Compacted 1 time');
    expect(interpolatePlural(en.chat.compactionCountBadge, 2)).toBe('Compacted 2 times');
    expect(interpolatePlural(en.chat.compactionTokensSaved, 1)).toBe('Saved 1 token');
    expect(interpolatePlural(en.toolResultSummary.readLines, 1)).toBe('Read 1 line');
    expect(interpolate(interpolatePlural(en.toolResultSummary.readLinesWithSize, 2), { size: 13 })).toBe('Read 2 lines (~13KB)');
    expect(interpolatePlural(en.deliveryExperience.blockedCommands, 1)).toBe('1 command not executed');
    expect(interpolatePlural(en.deliveryExperience.blockedSteps, 2)).toBe('2 steps not executed');
    expect(interpolatePlural(en.previewWorkspace.workspacePreview.restoredFiles, 1)).toBe('Restored 1 file.');
    expect(interpolatePlural(zh.chat.compactionCountBadge, 1)).toBe('已压缩 1 次');
    expect(interpolatePlural(zh.chat.compactionTokensSaved, 1)).toBe('节省 1 tokens');
    expect(interpolatePlural(zh.previewWorkspace.workspacePreview.restoredFiles, 2)).toBe('已恢复 2 个文件。');
  });
});

// 返修轮：任务面板头「Done · 1 steps」缺陷（workbenchTabs）+ baseline 里可见
// 任务/侧栏摘要的同类硬复数。en 1/2/0 各断言；zh one/other 同文，1 与 2 输出不变。
describe('rework: task-panel header and visible task/sidebar summaries (en 1 reads singular)', () => {
  it('workbenchTabs overviewRunStepsDone: total 1 reads "Done · 1 step" (the reported defect)', () => {
    expect(interpolatePlural(en.workbenchTabs.overviewRunStepsDone, 1)).toBe('Done · 1 step');
    expect(interpolatePlural(en.workbenchTabs.overviewRunStepsDone, 2)).toBe('Done · 2 steps');
    expect(interpolatePlural(en.workbenchTabs.overviewRunStepsDone, 0)).toBe('Done · 0 steps');
    expect(interpolatePlural(zh.workbenchTabs.overviewRunStepsDone, 1)).toBe('已完成 · 共 1 步');
    expect(interpolatePlural(zh.workbenchTabs.overviewRunStepsDone, 2)).toBe('已完成 · 共 2 步');
  });

  it('workbenchTabs agentWindow.tabCount', () => {
    expect(interpolatePlural(en.workbenchTabs.agentWindow.tabCount, 1)).toBe('1 tab');
    expect(interpolatePlural(en.workbenchTabs.agentWindow.tabCount, 2)).toBe('2 tabs');
    expect(interpolatePlural(zh.workbenchTabs.agentWindow.tabCount, 1)).toBe('1 个标签页');
  });

  it('sidebar: search hits / deleted conversations / automations / doctor checks', () => {
    expect(interpolatePlural(en.sidebar.messageHits, 1)).toBe('1 message match');
    expect(interpolatePlural(en.sidebar.messageHits, 2)).toBe('2 message matches');
    expect(interpolatePlural(en.sidebar.deletedCount, 1)).toBe('Deleted 1 conversation');
    expect(interpolatePlural(en.sidebar.deletedCount, 2)).toBe('Deleted 2 conversations');
    expect(interpolatePlural(en.sidebar.capabilityZone.automationCount, 1)).toBe('1 task');
    expect(interpolatePlural(en.sidebar.capabilityZone.automationCount, 2)).toBe('2 tasks');
    expect(interpolatePlural(en.sidebar.capabilityZone.doctorIssues, 1)).toBe('1 check failing');
    expect(interpolatePlural(en.sidebar.capabilityZone.doctorIssues, 2)).toBe('2 checks failing');
    expect(interpolatePlural(zh.sidebar.deletedCount, 1)).toBe('已删除 1 个对话');
    expect(interpolatePlural(zh.sidebar.capabilityZone.doctorIssues, 2)).toBe('2 项检查未通过');
  });

  it('sidebar project: goal / artifact / message counts, hidden sessions', () => {
    expect(interpolatePlural(en.sidebarProject.goalCountFallback, 1)).toBe('1 goal');
    expect(interpolatePlural(en.sidebarProject.goalCountFallback, 2)).toBe('2 goals');
    expect(interpolatePlural(en.sidebarProject.artifactCountFallback, 1)).toBe('1 artifact');
    expect(interpolatePlural(en.sidebarProject.artifactCountFallback, 2)).toBe('2 artifacts');
    expect(interpolatePlural(en.sidebarProject.messageCount, 1)).toBe('1 message');
    expect(interpolatePlural(en.sidebarProject.messageCount, 2)).toBe('2 messages');
    expect(interpolatePlural(en.sidebarProject.moreSessionsHidden, 1)).toBe('1 more session not shown');
    expect(interpolatePlural(en.sidebarProject.moreSessionsHidden, 2)).toBe('2 more sessions not shown');
    expect(interpolatePlural(zh.sidebarProject.messageCount, 1)).toBe('1 消息');
    expect(interpolatePlural(zh.sidebarProject.moreSessionsHidden, 2)).toBe('另有 2 条会话未展示');
  });

  it('turn rail: all turns / with messages / queued additions', () => {
    expect(interpolatePlural(en.turnRail.allTurns, 1)).toBe('All 1 turn');
    expect(interpolatePlural(en.turnRail.allTurns, 2)).toBe('All 2 turns');
    expect(interpolate(
      interpolatePlural(en.turnRail.allTurnsWithMessages, 1),
      { messages: 2 },
    )).toBe('All 1 turn · 2 messages');
    expect(interpolate(
      interpolatePlural(en.turnRail.allTurnsWithMessages, 2),
      { messages: 5 },
    )).toBe('All 2 turns · 5 messages');
    expect(interpolatePlural(en.turnRail.includesAdded, 1)).toBe('Includes 1 added message');
    expect(interpolatePlural(en.turnRail.includesAdded, 2)).toBe('Includes 2 added messages');
    expect(interpolatePlural(zh.turnRail.allTurns, 1)).toBe('全部 1 轮');
    expect(interpolate(
      interpolatePlural(zh.turnRail.allTurnsWithMessages, 2),
      { messages: 3 },
    )).toBe('全部 2 轮 · 共 3 条消息');
    expect(interpolatePlural(zh.turnRail.includesAdded, 1)).toBe('含 1 条追加消息');
  });

  it('session replay dialog: overflow rows', () => {
    expect(interpolatePlural(en.sessionReplay.dialog.moreOutputs, 1)).toBe('1 more output');
    expect(interpolatePlural(en.sessionReplay.dialog.moreOutputs, 2)).toBe('2 more outputs');
    expect(interpolatePlural(en.sessionReplay.dialog.moreTaskEvents, 1)).toBe('1 more task event');
    expect(interpolatePlural(en.sessionReplay.dialog.moreWorkflowRuns, 2)).toBe('2 more workflow runs');
    expect(interpolatePlural(en.sessionReplay.dialog.moreBackgroundTasks, 1)).toBe('1 more background task');
    expect(interpolatePlural(en.sessionReplay.dialog.moreTurnsHidden, 1)).toBe('1 more turn not shown');
    expect(interpolatePlural(en.sessionReplay.dialog.moreBlocks, 2)).toBe('2 more blocks');
    expect(interpolatePlural(zh.sessionReplay.dialog.moreTurnsHidden, 1)).toBe('另有 1 轮未展示');
    expect(interpolatePlural(zh.sessionReplay.dialog.moreBlocks, 2)).toBe('另有 2 个 block');
  });

  it('task status / background pill / checkout note / diff confirm', () => {
    expect(interpolatePlural(en.sessionTaskPresentation.checkedTimes, 1)).toBe('checked 1 time');
    expect(interpolatePlural(en.sessionTaskPresentation.checkedTimes, 2)).toBe('checked 2 times');
    expect(interpolatePlural(en.backgroundPanel.minimizedLabel, 1)).toBe('1 background task');
    expect(interpolatePlural(en.backgroundPanel.minimizedLabel, 2)).toBe('2 background tasks');
    expect(interpolatePlural(en.backgroundPanel.minimizedFinishedLabel, 1)).toBe('1 finished background task');
    expect(interpolatePlural(en.backgroundPanel.minimizedFinishedLabel, 2)).toBe('2 finished background tasks');
    expect(interpolatePlural(en.chat.turnCheckoutNoteChanged, 1)).toBe('1 workspace file was processed.');
    expect(interpolatePlural(en.chat.turnCheckoutNoteChanged, 2)).toBe('2 workspace files were processed.');
    expect(interpolatePlural(en.turnDiff.confirmMessage, 1)).toContain('changes to 1 file from this turn');
    expect(interpolatePlural(en.turnDiff.confirmMessage, 2)).toContain('changes to 2 files from this turn');
    expect(interpolatePlural(zh.chat.turnCheckoutNoteChanged, 1)).toBe('工作区处理了 1 个文件。');
    expect(interpolatePlural(zh.turnDiff.confirmMessage, 2)).toContain('将回滚本轮对 2 个文件的全部修改');
  });

  it('surface execution panel: session count and relative time', () => {
    const en2 = getSurfaceExecutionTranslations('en');
    const zh2 = getSurfaceExecutionTranslations('zh');
    expect(interpolatePlural(en2.panel.sessionCount, 1)).toBe('1 execution session');
    expect(interpolatePlural(en2.panel.sessionCount, 2)).toBe('2 execution sessions');
    expect(interpolatePlural(en2.timing.minutes, 1)).toBe('1 minute ago');
    expect(interpolatePlural(en2.timing.minutes, 2)).toBe('2 minutes ago');
    expect(interpolatePlural(en2.timing.hours, 1)).toBe('1 hour ago');
    expect(interpolatePlural(en2.timing.hours, 2)).toBe('2 hours ago');
    expect(interpolatePlural(zh2.panel.sessionCount, 1)).toBe('1 个执行会话');
    expect(interpolatePlural(zh2.timing.minutes, 2)).toBe('2 分钟前');
    expect(interpolatePlural(zh2.timing.hours, 1)).toBe('1 小时前');
  });
});
