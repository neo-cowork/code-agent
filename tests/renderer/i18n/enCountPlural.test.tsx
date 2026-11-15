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
