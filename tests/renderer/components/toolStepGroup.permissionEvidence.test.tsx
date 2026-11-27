// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const state = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
  resolved: [] as PermissionRequest[],
  pending: null as PermissionRequest | null,
  sendPrompt: vi.fn(async () => undefined),
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => ({
      t: state.language === 'en' ? en : zh,
      language: state.language,
    }),
  };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (value: Record<string, unknown>) => unknown) => selector({
    resolvedPermissionRequests: { 'session-1': state.resolved },
    pendingPermissionRequest: state.pending,
    pendingPermissionSessionId: state.pending ? 'session-1' : null,
    queuedPermissionRequests: {},
    // 真实 store 必有此字段（FB-595 起 ToolStepGroup 读它判会话在线）；桩里补齐。
    processingSessionIds: new Set<string>(),
    openPreview: vi.fn(),
    openSettingsTab: vi.fn(),
  }),
}));
vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector: (value: { sendPrompt: typeof state.sendPrompt }) => unknown) => selector({
    sendPrompt: state.sendPrompt,
  }),
}));

import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';

const toolNode: TraceNode = {
  id: 'node-tmeet',
  type: 'tool_call',
  content: '',
  timestamp: 1,
  toolCall: {
    id: 'call-tmeet',
    name: 'tmeetMeetingCreate',
    args: { subject: '临时会议' },
    stepLabel: 'tmeetMeetingCreate',
    result: 'ok',
    success: true,
  },
};

function resolved(decision: PermissionRequest['decision'], linked = true): PermissionRequest {
  return {
    id: `permission-${decision}`,
    sessionId: 'session-1',
    parentToolUseId: linked ? 'call-tmeet' : undefined,
    tool: 'tmeetMeetingCreate',
    type: 'file_write',
    details: { subject: '临时会议', start: '2026-08-26T09:00:00+08:00' } as PermissionRequest['details'],
    timestamp: 1,
    resolved: true,
    decision,
  };
}

afterEach(() => {
  cleanup();
  state.language = 'zh';
  state.resolved = [];
  state.pending = null;
  state.sendPrompt.mockClear();
});

describe('ToolStepGroup resolved permission evidence', () => {
  it('待审批工具主行使用请求式，不抢跑完成时', () => {
    state.pending = {
      id: 'permission-pending', sessionId: 'session-1', parentToolUseId: 'call-tmeet',
      tool: 'tmeetMeetingCreate', type: 'file_write',
      details: { subject: '临时会议' } as PermissionRequest['details'], timestamp: 1,
    };
    const pendingNode: TraceNode = { ...toolNode, toolCall: { ...toolNode.toolCall!, result: undefined, success: undefined } };
    render(<ToolStepGroup nodes={[pendingNode]} sessionId="session-1" isStreamingTurn />);

    const header = screen.getAllByRole('button', { expanded: false })[0]?.textContent ?? '';
    expect(header).toContain('请求创建会议');
    expect(header).not.toContain('创建了一场会议');
  });

  it('把允许结果放到对应工具步骤旁，并在折叠区保留完整参数', () => {
    state.resolved = [resolved('once')];
    render(<ToolStepGroup nodes={[toolNode]} sessionId="session-1" />);

    const evidence = screen.getByTestId('permission-decision-evidence');
    expect(evidence.textContent).toContain('你已允许 · 创建腾讯会议 临时会议');
    expect(screen.getByTestId('permission-decision-details').textContent).toContain('2026-08-26T09:00:00+08:00');
    expect(screen.queryByTestId('permission-card')).toBeNull();
  });

  it('超时结果保留步骤旁重试入口', () => {
    state.resolved = [resolved('timeout')];
    render(<ToolStepGroup nodes={[toolNode]} sessionId="session-1" />);

    expect(screen.getByTestId('permission-decision-evidence').textContent).toContain('已中断 · 等待回答或权限确认超时');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(state.sendPrompt).toHaveBeenCalledWith('刚才的审批超时了，请重试');
  });

  it('拒绝结果用审批终态词，并在组头和原因行说明为什么', () => {
    state.resolved = [resolved('deny')];
    const deniedNode: TraceNode = {
      ...toolNode,
      toolCall: {
        ...toolNode.toolCall!,
        result: 'Permission denied',
        success: false,
      },
    };
    render(<ToolStepGroup nodes={[deniedNode]} sessionId="session-1" />);

    // 折叠组头（#1-story-A 2c44c0cf9 起）只留一句具体原因，不再重复挂一个和原因近义的
    // 终态徽标词（"未获批准"≈"审批被拒绝"）——同一处 declutter 也发生在 ToolHeader 的
    // 单工具折叠行上。完整的 label · reason · stepLabel 三段仍然在展开的
    // permission-decision-evidence 明细里，折叠态收窄不等于信息丢失。
    const header = screen.getByRole('button', { expanded: false }).textContent ?? '';
    expect(header).toContain('审批被拒绝');
    expect(header).not.toContain('执行时出了问题');
    expect(header).not.toContain(zh.toolStepHumanize.failureReasonMissing);
    expect(screen.getByTestId('permission-decision-evidence').textContent).toContain('未获批准 · 审批被拒绝');
  });

  it('没有工具调用关联的旧请求不猜测归属', () => {
    state.resolved = [resolved('once', false)];
    render(<ToolStepGroup nodes={[toolNode]} sessionId="session-1" />);
    expect(screen.queryByTestId('permission-decision-evidence')).toBeNull();
  });

  describe('连续同类「你已允许」折叠（N-FIX-EXCEL-READ-APPROVAL-PER-CALL）', () => {
    const excelNodes: TraceNode[] = Array.from({ length: 7 }, (_, i) => ({
      id: `node-x${i}`, type: 'tool_call', content: '', timestamp: i,
      toolCall: { id: `call-x${i}`, name: 'ExcelAutomate', args: { action: 'read', file_path: `/outside/c${i}.xlsx` }, result: 'ok', success: true },
    }));
    const req = (i: number, decision: PermissionRequest['decision']): PermissionRequest => ({
      id: `perm-x${i}`, sessionId: 'session-1', parentToolUseId: `call-x${i}`, tool: 'ExcelAutomate', type: 'file_read',
      details: { action: 'read', file_path: `/outside/c${i}.xlsx` } as PermissionRequest['details'], timestamp: i, resolved: true, decision,
    });

    it('5 条连续已允许 → 1 行带次数', () => {
      state.resolved = [0, 1, 2, 3, 4].map((i) => req(i, 'once'));
      render(<ToolStepGroup nodes={excelNodes.slice(0, 5)} sessionId="session-1" />);
      const rows = screen.getAllByTestId('permission-decision-evidence');
      expect(rows).toHaveLength(1);
      expect(rows[0].textContent).toContain('你已允许 · 读取 c0.xlsx · 共 5 次');
    });

    it('non-adjacent Excel calls do not fold across another tool', () => {
      state.resolved = [req(0, 'once'), req(1, 'once')];
      render(<ToolStepGroup nodes={[excelNodes[0], toolNode, excelNodes[1]]} sessionId="session-1" />);
      expect(screen.getAllByTestId('permission-decision-evidence')).toHaveLength(2);
    });

    it('中间夹一条拒绝 → 不被折叠进去', () => {
      state.resolved = [req(0, 'once'), req(1, 'once'), req(2, 'deny'), req(3, 'once'), req(4, 'once')];
      render(<ToolStepGroup nodes={excelNodes.slice(0, 5)} sessionId="session-1" />);
      const rows = screen.getAllByTestId('permission-decision-evidence').map((r) => r.textContent ?? '');
      expect(rows).toHaveLength(3);
      expect(rows[0]).toContain('共 2 次');
      expect(rows[1]).not.toContain('共');
      expect(rows[1]).not.toContain('你已允许');
      expect(rows[2]).toContain('共 2 次');
    });
  });

  describe('用户拒绝后的下一步指引（N-FIX-FIX-PERM-DENY-ENGLISH-COPY-FU2）', () => {
    const deniedWriteNode: TraceNode = {
      id: 'node-write-denied',
      type: 'tool_call',
      content: '',
      timestamp: 1,
      toolCall: {
        id: 'call-write-denied',
        name: 'Write',
        args: { file_path: '/outside/summary.md', content: 'notes' },
        result: 'Permission denied by user.',
        success: false,
      },
    };
    const deniedWriteReq = (decision: PermissionRequest['decision']): PermissionRequest => ({
      id: `perm-write-${decision}`,
      sessionId: 'session-1',
      parentToolUseId: 'call-write-denied',
      tool: 'Write',
      type: 'file_write',
      details: { path: '/outside/summary.md' } as PermissionRequest['details'],
      timestamp: 1,
      resolved: true,
      decision,
    });

    it('zh 拒绝态：组头原因行和权限决策详情均包含下一步指引，且拒绝短语只出现一次', () => {
      state.language = 'zh';
      state.resolved = [deniedWriteReq('deny')];
      render(<ToolStepGroup nodes={[deniedWriteNode]} sessionId="session-1" />);

      const header = screen.getByRole('button', { expanded: false }).textContent ?? '';
      expect(header).toContain(zh.outcomeWords['failed-approval-denied'].timeline.reason);
      expect(header.match(/审批被拒绝/g)).toHaveLength(1);
      expect(header).toContain(zh.decisionCard.permission.deniedNextStep);

      const details = screen.getByTestId('permission-decision-details').textContent ?? '';
      expect(details).toContain('未获批准 · 审批被拒绝');
      expect(details).toContain(zh.decisionCard.permission.deniedNextStep);
    });

    it('en 拒绝态：组头原因行和权限决策详情均为纯英文且包含下一步指引', () => {
      state.language = 'en';
      state.resolved = [deniedWriteReq('deny')];
      render(<ToolStepGroup nodes={[deniedWriteNode]} sessionId="session-1" />);

      const header = screen.getByRole('button', { expanded: false }).textContent ?? '';
      expect(header).toContain(en.outcomeWords['failed-approval-denied'].timeline.reason);
      expect(header.match(/The approval was denied/g)).toHaveLength(1);
      expect(header).toContain(en.decisionCard.permission.deniedNextStep);
      expect(header).not.toMatch(/[\u4e00-\u9fff]/);

      const details = screen.getByTestId('permission-decision-details').textContent ?? '';
      expect(details).toContain('Not approved · The approval was denied');
      expect(details).toContain(en.decisionCard.permission.deniedNextStep);
      expect(details).not.toMatch(/[\u4e00-\u9fff]/);
    });

    it('超时态不附带拒绝下一步指引，并保留重试按钮与原超时文案（zh / en）', () => {
      state.language = 'zh';
      state.resolved = [deniedWriteReq('timeout')];
      const { unmount } = render(<ToolStepGroup nodes={[deniedWriteNode]} sessionId="session-1" />);

      const zhHeader = screen.getByRole('button', { expanded: false }).textContent ?? '';
      expect(zhHeader).toContain(zh.outcomeWords['failed-timeout'].timeline.reason);
      expect(zhHeader).not.toContain(zh.decisionCard.permission.deniedNextStep);
      const zhEvidence = screen.getByTestId('permission-decision-evidence').textContent ?? '';
      expect(zhEvidence).toContain('已中断 · 等待回答或权限确认超时');
      expect(zhEvidence).not.toContain(zh.decisionCard.permission.deniedNextStep);
      fireEvent.click(screen.getByRole('button', { name: zh.decisionCard.permission.retry }));
      expect(state.sendPrompt).toHaveBeenCalledWith(zh.decisionCard.permission.retryPrompt);
      unmount();

      state.language = 'en';
      state.sendPrompt.mockClear();
      render(<ToolStepGroup nodes={[deniedWriteNode]} sessionId="session-1" />);

      const enHeader = screen.getByRole('button', { expanded: false }).textContent ?? '';
      expect(enHeader).toContain(en.outcomeWords['failed-timeout'].timeline.reason);
      expect(enHeader).not.toContain(en.decisionCard.permission.deniedNextStep);
      const enEvidence = screen.getByTestId('permission-decision-evidence').textContent ?? '';
      expect(enEvidence).toContain('Interrupted · Waiting for an answer or permission timed out');
      expect(enEvidence).not.toContain(en.decisionCard.permission.deniedNextStep);
      fireEvent.click(screen.getByRole('button', { name: en.decisionCard.permission.retry }));
      expect(state.sendPrompt).toHaveBeenCalledWith(en.decisionCard.permission.retryPrompt);
    });
  });
});
