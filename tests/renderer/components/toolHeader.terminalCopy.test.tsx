// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';
import { humanizeToolFailureReason } from '../../../src/renderer/utils/toolExecutionPresentation';

vi.mock('../../../src/renderer/stores/appStore', () => {
  const state = {
    processingSessionIds: new Set<string>(),
    pendingPermissionRequest: null as Record<string, unknown> | null,
    pendingPermissionSessionId: null as string | null,
    queuedPermissionRequests: [] as Array<Record<string, unknown>>,
    openPreview: vi.fn(),
    workingDirectory: '/repo',
    language: 'zh' as const,
    setLanguage: vi.fn(),
    cloudUIStrings: undefined,
  };
  return {
    __mockAppState: state,
    useAppStore: (selector?: (value: typeof state) => unknown) => selector ? selector(state) : state,
  };
});

let mockCurrentSessionId: string | null = 'session-1';
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string | null }) => unknown) => (
    selector({ currentSessionId: mockCurrentSessionId })
  ),
}));

import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { ToolHeader } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolHeader';

afterEach(cleanup);

describe('ToolHeader terminal copy', () => {
  it('pending approval renders request phrasing instead of the completed write claim', () => {
    const toolCall: ToolCall = { id: 'write-pending', name: 'Write', arguments: { file_path: 'notes.md' } };
    const view = render(<ToolHeader toolCall={toolCall} status="pending" awaitingApproval />);
    expect(view.container.textContent).toContain('请求写入 notes.md');
    expect(view.container.textContent).not.toContain('写入了 notes.md');
  });

  it('被拒绝的腾讯会议创建行只显示一次终态与原因，并把动作写成意图式', () => {
    const toolCall: ToolCall = {
      id: 'tmeet-denied-1',
      name: 'tmeetMeetingCreate',
      arguments: { subject: '临时会议' },
      stepLabel: 'tmeetMeetingCreate',
      result: {
        toolCallId: 'tmeet-denied-1',
        success: false,
        error: '审批失败',
        metadata: { code: 'PERMISSION_DENIED' },
      },
    };

    const view = render(<ToolCallDisplay toolCall={toolCall} index={0} total={1} />);
    // #1-story-A 2c44c0cf9 起：失败原因搬进折叠行下方独立的一行（组件整体的兄弟节点，
    // 不再挂在 tool-call-row-... 这个 testid 内部），且不再重复一个和原因近义的终态徽标词
    // （"未获批准"≈"审批被拒绝"，ToolStepGroup 的同款折叠 declutter 见旁边那条测试）。
    // 用整个容器读，才是用户真实看到的"这一行 + 紧跟的原因"。
    const text = view.container.textContent ?? '';

    expect(text.match(/审批被拒绝/g)).toHaveLength(1);
    expect(text).toContain('创建会议');
    expect(text).not.toContain('创建了一场会议');
    expect(text).not.toContain('审批失败');
    expect(text).not.toContain(zh.toolStepHumanize.failureReasonMissing);
  });

  // ai-review #1741 Important：组件调用点不能绕过 util 里排好的顺序（hostReason 登记表 →
  // preflight → 其余）。原写法先调 toolPreflightCopy，用户在弹窗上亲手点的拒绝会被渲染成
  // 「未能自动批准」，而同一屏上方的组头显示「审批被拒绝」——同一件事两处自相矛盾。
  // 上一轮只在 util 层补了用例，挡不住这个调用点。
  it('a user-denied write reads the same in the expanded row as in the group head', () => {
    const toolCall: ToolCall = {
      id: 'w', name: 'Write', arguments: { file_path: '/workspace/report.md' },
      result: { toolCallId: 'w', success: false, error: 'not approved', metadata: {
        failureCode: 'permission-denied',
        hostReason: { code: 'PERMISSION_DENIED_BY_USER', modelText: 'user denied' },
      } },
    };
    const view = render(<ToolCallDisplay toolCall={toolCall} index={0} total={1} />);
    const text = view.container.textContent ?? '';
    expect(text).not.toContain(zh.deliveryExperience.approvalRequired);
    expect(text).toContain(humanizeToolFailureReason(toolCall, zh));
  });

  it('foreground spawn_agent renders pending-approval / running wording while active and only shows 未成功 with real reason on failure', async () => {
    const appStoreMod = await import('../../../src/renderer/stores/appStore') as unknown as {
      __mockAppState: {
        processingSessionIds: Set<string>;
        pendingPermissionRequest: Record<string, unknown> | null;
        pendingPermissionSessionId: string | null;
      };
    };
    const sessionId = 'session-ca8c3df9';
    mockCurrentSessionId = sessionId;
    appStoreMod.__mockAppState.processingSessionIds = new Set([sessionId]);
    appStoreMod.__mockAppState.pendingPermissionSessionId = sessionId;
    appStoreMod.__mockAppState.pendingPermissionRequest = {
      id: 'perm-1',
      sessionId,
      tool: 'Bash',
      parentToolUseId: 'call_33e127b9ca0a4c078fbad4c8',
    };

    const persistedRunningSpawnCall: ToolCall = {
      id: 'call_33e127b9ca0a4c078fbad4c8',
      name: 'spawn_agent',
      arguments: {
        role: 'coder',
        task: '严格按以下两阶段执行，不得偏离：【阶段一 · 唯一一次工具调用】首先且仅调用一次 Bash 工具，命令为：printf "ok" > /tmp/neo-approve-test.txt',
      },
    };

    const approvalView = render(
      <ToolCallDisplay
        toolCall={persistedRunningSpawnCall}
        index={0}
        total={1}
        mediaContext={{ sessionId, messageId: '438997a6' }}
      />,
    );
    const approvalText = approvalView.container.textContent ?? '';
    expect(approvalText).toContain('请求启动代理');
    expect(approvalText).not.toContain('启动代理未成功');
    approvalView.unmount();

    // User clicks Allow: pendingPermissionRequest clears, child continues running
    appStoreMod.__mockAppState.pendingPermissionRequest = null;
    const runningView = render(
      <ToolCallDisplay
        toolCall={persistedRunningSpawnCall}
        index={0}
        total={1}
        mediaContext={{ sessionId, messageId: '438997a6' }}
      />,
    );
    const runningText = runningView.container.textContent ?? '';
    expect(runningText).toContain('正在启动代理');
    expect(runningText).not.toContain('启动代理未成功');
    expect(runningText).not.toContain('已中断');
    runningView.unmount();

    // Real failure (persisted call_5fa74e436eb64c64be688ce9) shows 未成功 and its mapped failure reason, not failureReasonMissing
    const persistedFailedSpawnCall: ToolCall = {
      id: 'call_5fa74e436eb64c64be688ce9',
      name: 'spawn_agent',
      arguments: {
        role: 'general-purpose',
        task: '严格按以下两阶段执行，不得偏离：【阶段一 · 唯一一次工具调用】首先且仅调用一次 Bash 工具，命令为：printf "ok" > /tmp/neo-approve-test.txt',
      },
      result: {
        toolCallId: 'call_5fa74e436eb64c64be688ce9',
        success: false,
        error: 'Invalid agent ID: "general-purpose". Valid IDs: coder, reviewer, explore, plan, awaiter, dream, distill, 万卷, 持衡, 数据分析师, 明镜, 溯真, 牧之, 记言, 青禾',
        duration: 308,
        metadata: {
          executionStarted: true,
          fromCache: false,
          memoryTainted: true,
        },
      },
    };
    const failedView = render(
      <ToolCallDisplay
        toolCall={persistedFailedSpawnCall}
        index={0}
        total={1}
        mediaContext={{ sessionId, messageId: '69aeef46' }}
      />,
    );
    const failedText = failedView.container.textContent ?? '';
    expect(failedText).toContain('启动代理未成功');
    expect(failedText).toContain(zh.toolStepHumanize.failureCodes['tool-unavailable']);
    expect(failedText).not.toContain(zh.toolStepHumanize.failureReasonMissing);

    mockCurrentSessionId = 'session-1';
    appStoreMod.__mockAppState.processingSessionIds = new Set();
    appStoreMod.__mockAppState.pendingPermissionSessionId = null;
  });
});
