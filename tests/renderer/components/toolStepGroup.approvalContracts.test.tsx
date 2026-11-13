// @vitest-environment jsdom
// Related row contracts share a file; each suite retains its own store and IPC fixtures.
import React from 'react';
import { fireEvent,render,screen,cleanup } from '@testing-library/react';
import { describe,expect,it,vi,afterEach,beforeEach,beforeAll,afterAll } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import type { TurnSegment } from '../../../src/renderer/components/TaskPanel/SessionInspector/model';
import type { PermissionRequest,PlanApprovalRecord,Message } from '../../../src/shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';
import { renderToStaticMarkup } from 'react-dom/server';

describe('rendererHumanPipe.consumerContract',() => {
  let ToolStepGroup: typeof import('../../../src/renderer/components/features/chat/ToolStepGroup')['ToolStepGroup'];
  let TurnRow: typeof import('../../../src/renderer/components/TaskPanel/SessionInspector/turnRow')['TurnRow'];
  let SidebarStatusFilterDropdown: typeof import('../../../src/renderer/components/features/sidebar/SidebarStatusFilterDropdown')['SidebarStatusFilterDropdown'];
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('../../../src/renderer/hooks/useI18n',async () => {
      const { zh }=await import('../../../src/renderer/i18n/zh');
      return { useI18n: () => ({ t: zh,language: 'zh' }) };
    });
    vi.doMock('../../../src/renderer/stores/appStore',() => {
      const useAppStore=(selector: (state: unknown) => unknown) => selector({
        resolvedPermissionRequests: {},
        openPreview: vi.fn(),
        openSettingsTab: vi.fn(),
      });
      return { useAppStore: Object.assign(useAppStore,{ getState: () => useAppStore((state) => state) }) };
    });
    vi.doMock('../../../src/renderer/stores/messageActionStore',() => ({
      useMessageActionStore: (selector: (state: unknown) => unknown) => selector({ sendPrompt: vi.fn() }),
    }));
    ToolStepGroup=(await import('../../../src/renderer/components/features/chat/ToolStepGroup')).ToolStepGroup;
    TurnRow=(await import('../../../src/renderer/components/TaskPanel/SessionInspector/turnRow')).TurnRow;
    SidebarStatusFilterDropdown=(await import('../../../src/renderer/components/features/sidebar/SidebarStatusFilterDropdown')).SidebarStatusFilterDropdown;
  });
  afterAll(() => {
    vi.doUnmock('../../../src/renderer/hooks/useI18n');
    vi.doUnmock('../../../src/renderer/stores/appStore');
    vi.doUnmock('../../../src/renderer/stores/messageActionStore');
    vi.resetModules();
  });


  const INTERNAL_TOOL_ID=/\b[a-z]+[A-Z][A-Za-z]+\b/;

  const PERSISTED_MARKER=/\[(?:cancelled|aborted|interrupted|pending)[^\]]*\]/i;


  function expectHumanFacing(text: string): void {
    expect(text).not.toMatch(INTERNAL_TOOL_ID);
    expect(text).not.toMatch(PERSISTED_MARKER);
  }


  function timelineNode(): TraceNode {
    return {
      id: 'timeline-tool',
      type: 'tool_call',
      content: '',
      timestamp: 1,
      toolCall: {
        id: 'timeline-call',
        name: 'futureCamelTool',
        args: {},
        success: false,
        result: '[cancelled] VendorRouterError',
      },
    } as TraceNode;
  }


  function taskPanelSegment(): TurnSegment {
    return {
      index: 1,
      events: [],
      stamp: null,
      inProgress: false,
      toolDispatches: [
        { toolName: 'TaskManager',success: true,durationMs: 8,error: null,fromCache: false,bucket: 'other' },
        {
          toolName: 'futureCamelTool',
          success: false,
          durationMs: 12,
          error: '[cancelled] VendorRouterError at internal.ts:18',
          fromCache: false,
          bucket: 'other',
        },
      ],
      decisions: [],
      inferences: [],
      manifests: [],
      verificationCount: 0,
      verificationSkippedCount: 0,
      compactionCount: 0,
      tokens: { input: 0,output: 0,cacheRead: 0 },
      toolCounts: { read: 0,write: 0,command: 0,browser: 0,other: 2 },
      failedToolCount: 1,
      tokenAnomaly: false,
      lastToolBucket: 'other',
      inferenceCalls: [],
      orphanToolDispatches: [],
      startedAt: null,
      endedAt: null,
    };
  }


  function renderSidebar(showTrajectoryFilters: boolean) {
    return render(
      <SidebarStatusFilterDropdown
        statusFilterOpen
        setStatusFilterOpen={vi.fn()}
        statusFilterRef={React.createRef<HTMLDivElement>()}
        visibleStatusFilterOptions={[{ id: 'all',label: '全部' }]}
        sessionStatusFilter="all"
        setSessionStatusFilter={vi.fn()}
        trajectoryTierFilter="all"
        setTrajectoryTierFilter={vi.fn()}
        trajectoryFailureFilter="all"
        setTrajectoryFailureFilter={vi.fn()}
        trajectoryReviewFilter="all"
        setTrajectoryReviewFilter={vi.fn()}
        hasActiveTrajectoryFilter={false}
        hasActiveStatusDropdownFilter={false}
        activeStatusFilterLabel="全部"
        showTrajectoryFilters={showTrajectoryFilters}
      />,
    );
  }


  describe('renderer human-pipe consumer contract',() => {
    it('时间线主行、任务面板行、侧栏筛选标签均不暴露工具 ID 或落库标记',() => {
      const timeline=render(<ToolStepGroup nodes={[timelineNode()]} />);
      expectHumanFacing(timeline.container.textContent??'');
      timeline.unmount();

      const taskPanel=render(<TurnRow segment={taskPanelSegment()} />);
      fireEvent.click(screen.getByTestId('inspector-activity-detail-toggle'));
      expectHumanFacing(screen.getByTestId('inspector-activity-detail').textContent??'');
      taskPanel.unmount();

      const sidebar=renderSidebar(true);
      expectHumanFacing(sidebar.container.textContent??'');
      expect(sidebar.container.textContent).toContain('会话质量复核');
      expect(sidebar.container.textContent).not.toMatch(/\bG[012]\b/);
      expect(sidebar.container.textContent).not.toContain('missing_tool_result');
    });

    it('Trajectory 筛选只向管理员开放',() => {
      const sidebar=renderSidebar(false);
      expect(sidebar.container.textContent).not.toContain('会话质量复核');
      expect(sidebar.container.textContent).not.toContain('需要诊断');
      expect(sidebar.container.textContent).not.toContain('有步骤没有返回结果');
    });

    it('任务面板窄列复用连接器动作，同轮两次日历查询能区分',() => {
      const segment=taskPanelSegment();
      segment.toolDispatches=[
        {
          toolName: 'calendar',toolAction: 'list_calendars',success: true,
          durationMs: 8,error: null,fromCache: false,bucket: 'other',
        },
        {
          toolName: 'calendar',toolAction: 'list_events',success: true,
          durationMs: 12,error: null,fromCache: false,bucket: 'other',
        },
      ];
      const view=render(<TurnRow segment={segment} />);
      fireEvent.click(screen.getByTestId('inspector-activity-detail-toggle'));
      const rows=screen.getAllByTestId('inspector-activity-detail-row');

      expect(rows[0].textContent).toContain('日历 · 查询了可用列表');
      expect(rows[1].textContent).toContain('日历 · 查询了日程');
      expect(rows.map((row) => row.textContent).join('\n')).not.toContain('执行了操作');
      view.unmount();
    });
  });
});

describe('toolStepGroup.permissionEvidence',() => {
  let ToolStepGroup: typeof import('../../../src/renderer/components/features/chat/ToolStepGroup')['ToolStepGroup'];
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('../../../src/renderer/hooks/useI18n',async () => {
      const { zh }=await import('../../../src/renderer/i18n/zh');
      return { useI18n: () => ({ t: zh,language: 'zh' }) };
    });
    vi.doMock('../../../src/renderer/stores/appStore',() => {
      const useAppStore=(selector: (value: Record<string,unknown>) => unknown) => selector({
        resolvedPermissionRequests: { 'session-1': state.resolved },
        pendingPermissionRequest: state.pending,
        pendingPermissionSessionId: state.pending? 'session-1':null,
        queuedPermissionRequests: {},
        // 真实 store 必有此字段（FB-595 起 ToolStepGroup 读它判会话在线）；桩里补齐。
        processingSessionIds: new Set<string>(),
        openPreview: vi.fn(),
        openSettingsTab: vi.fn(),
      });
      return { useAppStore: Object.assign(useAppStore,{ getState: () => useAppStore((value) => value) }) };
    });
    vi.doMock('../../../src/renderer/stores/messageActionStore',() => ({
      useMessageActionStore: (selector: (value: { sendPrompt: typeof state.sendPrompt }) => unknown) => selector({
        sendPrompt: state.sendPrompt,
      }),
    }));
    ToolStepGroup=(await import('../../../src/renderer/components/features/chat/ToolStepGroup')).ToolStepGroup;
  });
  afterAll(() => {
    vi.doUnmock('../../../src/renderer/hooks/useI18n');
    vi.doUnmock('../../../src/renderer/stores/appStore');
    vi.doUnmock('../../../src/renderer/stores/messageActionStore');
    vi.resetModules();
  });


  const state=(() => ({
    resolved: [] as PermissionRequest[],
    pending: null as PermissionRequest|null,
    sendPrompt: vi.fn(async () => undefined),
  }))();


  const toolNode: TraceNode={
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


  function resolved(decision: PermissionRequest['decision'],linked=true): PermissionRequest {
    return {
      id: `permission-${decision}`,
      sessionId: 'session-1',
      parentToolUseId: linked? 'call-tmeet':undefined,
      tool: 'tmeetMeetingCreate',
      type: 'file_write',
      details: { subject: '临时会议',start: '2026-08-26T09:00:00+08:00' } as PermissionRequest['details'],
      timestamp: 1,
      resolved: true,
      decision,
    };
  }


  afterEach(() => {
    cleanup();
    state.resolved=[];
    state.pending=null;
    state.sendPrompt.mockClear();
  });


  describe('ToolStepGroup resolved permission evidence',() => {
    it('待审批工具主行使用请求式，不抢跑完成时',() => {
      state.pending={
        id: 'permission-pending',sessionId: 'session-1',parentToolUseId: 'call-tmeet',
        tool: 'tmeetMeetingCreate',type: 'file_write',
        details: { subject: '临时会议' } as PermissionRequest['details'],timestamp: 1,
      };
      const pendingNode: TraceNode={ ...toolNode,toolCall: { ...toolNode.toolCall!,result: undefined,success: undefined } };
      render(<ToolStepGroup nodes={[pendingNode]} sessionId="session-1" isStreamingTurn />);

      const header=screen.getAllByRole('button',{ expanded: false })[0]?.textContent??'';
      expect(header).toContain('请求创建会议');
      expect(header).not.toContain('创建了一场会议');
    });

    it('把允许结果放到对应工具步骤旁，并在折叠区保留完整参数',() => {
      state.resolved=[resolved('once')];
      render(<ToolStepGroup nodes={[toolNode]} sessionId="session-1" />);

      const evidence=screen.getByTestId('permission-decision-evidence');
      expect(evidence.textContent).toContain('你已允许 · 创建腾讯会议 临时会议');
      expect(screen.getByTestId('permission-decision-details').textContent).toContain('2026-08-26T09:00:00+08:00');
      expect(screen.queryByTestId('permission-card')).toBeNull();
    });

    it('超时结果保留步骤旁重试入口',() => {
      state.resolved=[resolved('timeout')];
      render(<ToolStepGroup nodes={[toolNode]} sessionId="session-1" />);

      expect(screen.getByTestId('permission-decision-evidence').textContent).toContain('已中断 · 等待回答或权限确认超时');
      fireEvent.click(screen.getByRole('button',{ name: '重试' }));
      expect(state.sendPrompt).toHaveBeenCalledWith('刚才的审批超时了，请重试');
    });

    it('拒绝结果用审批终态词，并在组头和原因行说明为什么',() => {
      state.resolved=[resolved('deny')];
      const deniedNode: TraceNode={
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
      const header=screen.getByRole('button',{ expanded: false }).textContent??'';
      expect(header).toContain('审批被拒绝');
      expect(header).not.toContain('执行时出了问题');
      expect(header).not.toContain(zh.toolStepHumanize.failureReasonMissing);
      expect(screen.getByTestId('permission-decision-evidence').textContent).toContain('未获批准 · 审批被拒绝');
    });

    it('没有工具调用关联的旧请求不猜测归属',() => {
      state.resolved=[resolved('once',false)];
      render(<ToolStepGroup nodes={[toolNode]} sessionId="session-1" />);
      expect(screen.queryByTestId('permission-decision-evidence')).toBeNull();
    });
  });
});

describe('toolStepGroup.planApprovalEvidence',() => {
  let ToolStepGroup: typeof import('../../../src/renderer/components/features/chat/ToolStepGroup')['ToolStepGroup'];
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('../../../src/renderer/hooks/useI18n',async () => {
      const { zh }=await import('../../../src/renderer/i18n/zh');
      return { useI18n: () => ({ t: zh,language: 'zh' }) };
    });
    vi.doMock('../../../src/renderer/stores/appStore',() => {
      const useAppStore=(selector: (state: unknown) => unknown) =>
        selector({
          openPreview: vi.fn(),
          openSettingsTab: vi.fn(),
        });
      return { useAppStore: Object.assign(useAppStore,{ getState: () => useAppStore((state) => state) }) };
    });
    vi.doMock('../../../src/renderer/stores/sessionStore',() => ({
      useSessionStore: (selector: (state: unknown) => unknown) => selector(h.sessionState),
    }));
    ToolStepGroup=(await import('../../../src/renderer/components/features/chat/ToolStepGroup')).ToolStepGroup;
  });
  afterAll(() => {
    vi.doUnmock('../../../src/renderer/hooks/useI18n');
    vi.doUnmock('../../../src/renderer/stores/appStore');
    vi.doUnmock('../../../src/renderer/stores/sessionStore');
    vi.resetModules();
  });


  const h=(() => ({
    sessionState: { currentSessionId: null as string|null,messages: [] as unknown[] },
  }))();


  const approval: PlanApprovalRecord={
    status: 'failed',
    originalPlan: '1. Read code\n2. Build card',
    steps: [
      { id: 'step-1',content: 'Read code',originalContent: 'Read code' },
      { id: 'step-2',content: 'Build card',originalContent: 'Build card' },
    ],
    failureReason: 'Session s1 is already running',
    decidedAt: 10,
  };


  function planNode(id: string,record: PlanApprovalRecord): TraceNode {
    // TraceNode 的 toolCall.result 是字符串、元数据挂 toolCall.metadata（ToolStepGroup
    // 构造 ToolCall 时搬运），与 Message.toolCalls 的形状不同。
    return {
      id: `node-${id}`,
      type: 'tool_call',
      content: '',
      timestamp: 1,
      toolCall: {
        id,
        name: 'exit_plan_mode',
        args: {},
        success: true,
        result: 'ok',
        metadata: { confirmationType: 'plan_approval',plan: record.originalPlan,planApproval: record },
      },
    } as unknown as TraceNode;
  }


  function messageOf(id: string,record: PlanApprovalRecord): Message {
    return {
      id: `message-${id}`,
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [{
        id,
        name: 'exit_plan_mode',
        arguments: {},
        result: {
          toolCallId: id,
          success: true,
          metadata: { confirmationType: 'plan_approval',plan: record.originalPlan,planApproval: record },
        },
      }],
    };
  }


  describe('ToolStepGroup — failed 计划卡的归属：待决目标交还交互卡，旧卡补存证',() => {
    beforeEach(() => {
      h.sessionState.currentSessionId='session-1';
      h.sessionState.messages=[];
    });

    it('failed 卡是当前待决目标（最新可决定卡）→ 交还交互卡，不落存证',() => {
      h.sessionState.messages=[messageOf('tool-failed',approval)];
      const html=renderToStaticMarkup(<ToolStepGroup nodes={[planNode('tool-failed',approval)]} />);
      expect(html).not.toContain('plan-approval-evidence');
      expect(html).not.toContain('计划 · 启动失败');
    });

    it('会话里有更新的 pending 审批 → 旧 failed 卡补只读存证条，不再整条消失',() => {
      const newerPending: PlanApprovalRecord={ ...approval,status: 'pending' };
      delete (newerPending as { failureReason?: string }).failureReason;
      h.sessionState.messages=[messageOf('tool-failed',approval),messageOf('tool-pending-new',newerPending)];
      const html=renderToStaticMarkup(<ToolStepGroup nodes={[planNode('tool-failed',approval)]} />);
      expect(html).toContain('plan-approval-evidence');
      expect(html).toContain('计划 · 启动失败');
    });

    it('approved / starting 等终态与中间态照旧渲染存证条（行为不变）',() => {
      const approved: PlanApprovalRecord={ ...approval,status: 'approved' };
      delete (approved as { failureReason?: string }).failureReason;
      const html=renderToStaticMarkup(<ToolStepGroup nodes={[planNode('tool-approved',approved)]} />);
      expect(html).toContain('plan-approval-evidence');
      expect(html).toContain('已允许');
    });

    it('pending 卡仍交还交互卡（不改既有行为）',() => {
      const pending: PlanApprovalRecord={ ...approval,status: 'pending' };
      delete (pending as { failureReason?: string }).failureReason;
      h.sessionState.messages=[messageOf('tool-pending',pending)];
      const html=renderToStaticMarkup(<ToolStepGroup nodes={[planNode('tool-pending',pending)]} />);
      expect(html).not.toContain('plan-approval-evidence');
    });
  });
});

describe('toolStepGroup.superseded',() => {
  let ToolStepGroup: typeof import('../../../src/renderer/components/features/chat/ToolStepGroup')['ToolStepGroup'];
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('../../../src/renderer/hooks/useI18n',async () => {
      const { zh: copy }=await import('../../../src/renderer/i18n/zh');
      return { useI18n: () => ({ t: copy,language: 'zh' }) };
    });
    vi.doMock('../../../src/renderer/stores/appStore',() => {
      const useAppStore=(selector: (state: {
        processingSessionIds: Set<string>;
        openPreview: () => void;
        pendingPermissionRequest: null;
        pendingPermissionSessionId: null;
        queuedPermissionRequests: [];
        resolvedPermissionRequests: Record<string,PermissionRequest[]>;
      }) => unknown) => selector({
        processingSessionIds: new Set(),
        openPreview: vi.fn(),
        pendingPermissionRequest: null,
        pendingPermissionSessionId: null,
        queuedPermissionRequests: [],
        resolvedPermissionRequests: { 'session-1': [supersededRequest] },
      });
      return { useAppStore: Object.assign(useAppStore,{ getState: () => useAppStore((state) => state) }) };
    });
    vi.doMock('../../../src/renderer/stores/sessionStore',() => ({
      useSessionStore: (selector: (state: { currentSessionId: string; messages: [] }) => unknown) => (
        selector({ currentSessionId: 'session-1',messages: [] })
      ),
    }));
    vi.doMock('../../../src/renderer/stores/backgroundTaskStore',() => ({
      useBackgroundTaskStore: (selector: (state: { tasks: [] }) => unknown) => selector({ tasks: [] }),
    }));
    vi.doMock('../../../src/renderer/hooks/useAgentTreeSnapshot',() => ({
      useAgentTreeSnapshot: () => ({ snapshot: null,refresh: vi.fn() }),
    }));
    ToolStepGroup=(await import('../../../src/renderer/components/features/chat/ToolStepGroup')).ToolStepGroup;
  });
  afterAll(() => {
    vi.doUnmock('../../../src/renderer/hooks/useI18n');
    vi.doUnmock('../../../src/renderer/stores/appStore');
    vi.doUnmock('../../../src/renderer/stores/sessionStore');
    vi.doUnmock('../../../src/renderer/stores/backgroundTaskStore');
    vi.doUnmock('../../../src/renderer/hooks/useAgentTreeSnapshot');
    vi.resetModules();
  });


  const { supersededRequest }=(() => ({
    supersededRequest: {
      id: 'perm-1',
      type: 'file_delete',
      tool: 'Bash',
      details: { command: 'rm b.txt' },
      timestamp: 1,
      sessionId: 'session-1',
      parentToolUseId: 'call-1',
      resolved: true,
      decision: 'superseded',
    } as PermissionRequest,
  }))();


  describe('被新消息取代的审批卡',() => {
    it('步骤上显示取代，不显示拒绝、超时或重试',() => {
      const node: TraceNode={
        id: 'tool-1',
        type: 'tool_call',
        content: '',
        timestamp: 1,
        toolCall: {
          id: 'call-1',
          name: 'Bash',
          args: { command: 'rm b.txt' },
          success: true,
          result: 'removed a.txt',
        },
      };
      const html=renderToStaticMarkup(<ToolStepGroup nodes={[node]} sessionId="session-1" />);
      const permission=zh.decisionCard.permission;
      expect(html).toContain(permission.settledSuperseded);
      expect(html).not.toContain(permission.settledDenied);
      expect(html).not.toContain(permission.settledTimeout);
      expect(html).not.toContain(permission.retry);
    });
  });
});
