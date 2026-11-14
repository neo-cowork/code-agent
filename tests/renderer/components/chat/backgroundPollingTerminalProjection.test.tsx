// @vitest-environment jsdom
import type { AgentTreeNodeStatus } from '../../../../src/shared/contract/agentTree';
import { IPC_DOMAINS } from '../../../../src/shared/ipc';
import { ToolCallDisplay } from '../../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';
import { resolveToolCallTerminalState } from '../../../../src/renderer/utils/toolCallTerminalState';
import { getToolStatusLabel } from '../../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/statusLabels';
import { buildToolStatusLineCopy } from '../../../../src/renderer/utils/toolStatusLinePresentation';
import { languages } from '../../../../src/renderer/i18n';
import { useAgentTreeSnapshot } from '../../../../src/renderer/hooks/useAgentTreeSnapshot';
import React from 'react';
import { readFileSync } from 'node:fs';
import { act,renderHook,cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import type { ToolCall,Message } from '../../../../src/shared/contract';
import type { Task } from '../../../../src/shared/contract/backgroundTask';
import type { TraceNode } from '../../../../src/shared/contract/trace';
import ipcService from '../../../../src/renderer/services/ipcService';
import { TraceNodeRenderer } from '../../../../src/renderer/components/features/chat/TraceNodeRenderer';
import { ToolStepGroup } from '../../../../src/renderer/components/features/chat/ToolStepGroup';
import { AgentErrorPresentation } from '../../../../src/renderer/components/features/chat/AgentErrorCard';
import { projectTurns } from '../../../../src/renderer/hooks/useTurnProjection';
import { useAppStore } from '../../../../src/renderer/stores/appStore';
import { useBackgroundTaskStore } from '../../../../src/renderer/stores/backgroundTaskStore';
import { useSessionStore } from '../../../../src/renderer/stores/sessionStore';

describe('terminal projection fixtures',() => {
  const SESSION='polling-session';
  function task(status: Task['status']='completed',toolCallId='delegate'): Task {
    return {
      id: `task-${toolCallId}`,source: 'session_command_center',sessionId: SESSION,toolCallId,
      title: '运行项目测试',status,createdAt: 1,updatedAt: 5,events: [],outputRefs: []
    };
  }
  function node(id='delegate',name='delegate_task',extra: Partial<NonNullable<TraceNode['toolCall']>>={}): TraceNode {
    return {
      id: `node-${id}`,type: 'tool_call',content: '',timestamp: 2,
      toolCall: { id,name,args: { title: '运行项目测试',command: 'npm test',run_in_background: true },...extra }
    };
  }
  beforeEach(() => {
    useAppStore.setState({ language: 'zh',processingSessionIds: new Set(),pendingPermissionRequest: null,pendingPermissionSessionId: null,queuedPermissionRequests: {} });
    useSessionStore.setState({ currentSessionId: SESSION,messages: [],runningSessionIds: new Set() });
    useBackgroundTaskStore.setState({ tasks: [] });
  });
  afterEach(() => { vi.restoreAllMocks(); cleanup(); useBackgroundTaskStore.setState({ tasks: [] }); });

  describe('background polling terminal projection',() => {
    it.each([
      ['completed ledger','completed',undefined,false,false],
      ['running ledger','running',undefined,false,false],
      ['failed ledger','failed',undefined,true,false],
      ['real failure wins completed ledger','completed',false,true,false],
      ['real success wins failed ledger','failed',true,false,false],
      ['offline no result',undefined,undefined,false,true],
    ] as const)('%s settles both collapsed header and expanded rows',(_name,ledger,success,failed,interrupted) => {
      if(ledger) useBackgroundTaskStore.setState({ tasks: [task(ledger)] });
      render(<ToolStepGroup nodes={[node('delegate','Bash',success===undefined? {}:{ success,result: success? 'passed':'test failed' })]} sessionId={SESSION} defaultExpanded />);
      const text=document.body.textContent??'';
      console.log('TERMINAL_TABLE_RAW',_name,text);
      expect(text.includes('已中断')).toBe(interrupted);
      if(!interrupted) expect(text.includes('未成功')).toBe(failed);
      expect(screen.queryAllByTestId('interrupt-timeline-step').length>0).toBe(interrupted);
    });
    it.each(['completed','failed'] as const)('sub-agent %s uses the same agent-tree row source as the member bar',async (status) => {
      vi.spyOn(ipcService,'invokeDomain').mockResolvedValue({
        generatedAt: 5,sessionId: SESSION,roots: [],
        nodes: [{
          id: 'child',role: 'explore',status,statusLabel: status,children: [],sources: ['subagentContext'],
          worktreeState: { status: 'none' },budgetSummary: {},evidenceRefs: []
        }],
        summary: { ownershipConflicts: [] },
      });
      const child=node('child-command','Bash');
      child.metadata={ agentTeam: { sessionId: SESSION,runId: 'child-run',treeId: 'tree',agentId: 'child' } };
      render(<ToolStepGroup nodes={[child]} sessionId={SESSION} defaultExpanded />);
      await waitFor(() => expect(document.body.textContent).not.toContain('已中断'));
      expect(document.body.textContent?.includes('未成功')).toBe(status==='failed');
      console.log('SUBAGENT_ROW_RAW',status,document.body.textContent);
    });
    it('a completed agent unrelated to the call cannot settle it',async () => {
      vi.spyOn(ipcService,'invokeDomain').mockResolvedValue({
        generatedAt: 5,roots: [],
        nodes: [{
          id: 'other',role: 'explore',status: 'completed',children: [],sources: ['subagentContext'],
          worktreeState: { status: 'none' },budgetSummary: {},evidenceRefs: []
        }],summary: { ownershipConflicts: [] }
      });
      render(<ToolStepGroup nodes={[node('own-command','Bash')]} sessionId={SESSION} defaultExpanded />);
      await waitFor(() => expect(screen.getByTestId('interrupt-timeline-step')).toBeTruthy());
    });
    it('shape a: lone delegate without result settles from its completed ledger',() => {
      useBackgroundTaskStore.setState({ tasks: [task()] });
      render(<ToolStepGroup nodes={[node()]} sessionId={SESSION} />);
      console.log('SHAPE_A_RAW',document.body.textContent);
      expect(document.body.textContent).not.toMatch(/已中断|未成功/);
      expect(document.body.textContent).toContain('运行项目测试');
    });
    it('shape b: collapsed header single visible delegate agrees with expanded rows after completed Bash placeholder hides',() => {
      useBackgroundTaskStore.setState({ tasks: [task(),{ ...task('completed','bash'),source: 'shell',kind: 'shell' }] });
      render(<ToolStepGroup nodes={[node(),node('bash','Bash')]} sessionId={SESSION} />);
      const header=screen.getByTestId('tool-group-head-label');
      console.log('COLLAPSED_HEADER_RAW',header.textContent);
      expect(header.textContent).not.toMatch(/已中断|未成功/);
      fireEvent.click(header.closest('button')!);
      console.log('EXPANDED_ROWS_RAW',document.body.textContent);
      expect(document.body.textContent).not.toMatch(/已中断|未成功/);
    });
    it('awaiting approval stays pending while the session is offline',() => {
      useAppStore.setState({ pendingPermissionSessionId: SESSION,pendingPermissionRequest: { id: 'approval',tool: 'Bash',parentToolUseId: 'delegate',details: {} } as never });
      render(<ToolStepGroup nodes={[node('delegate','Bash')]} sessionId={SESSION} defaultExpanded />);
      expect(document.body.textContent).not.toContain('已中断');
    });
    it('shape c: three polling handbacks with wake users and intervening assistant content leave at most one full same-reason card',() => {
      const messages: Message[]=[{ id: 'user',role: 'user',content: '后台运行项目测试，帮我看三次进度。',timestamp: 1 }];
      for(let i=1;i<=3;i++) {
        messages.push({
          id: `poll-${i}`,role: 'assistant',content: '',timestamp: i*10,
          toolCalls: [{ id: `check-${i}`,name: 'task_status',arguments: {} }]
        });
        messages.push({
          id: `failure-${i}`,role: 'assistant',content: '已达本任务的最大步骤上限。',timestamp: i*10+1,
          metadata: { agentError: { category: 'generic',code: 'MAX_ITERATIONS_REACHED',rawMessage: 'Max iterations reached',timestamp: i*10+1 } }
        });
        if(i<3) messages.push({
          id: `wake-${i}`,role: 'user',content: '后台任务进度更新。',timestamp: i*10+2,isMeta: true,
          metadata: { backgroundTaskResult: { source: 'agent-result',taskId: 'task-delegate',shortName: '项目测试',status: 'unverified',summary: '仍在运行' } }
        });
        if(i===1) messages.push({ id: 'progress',role: 'assistant',content: '项目测试仍在进行，稍后我会继续查看。',timestamp: 13 });
      }
      const nodes=projectTurns(messages,SESSION,false).turns.flatMap(turn => turn.nodes);
      render(<>{nodes.filter(n => n.metadata?.agentError).map(n => <AgentErrorPresentation key={n.id} error={n.metadata!.agentError!} messageId={n.messageId??n.id} sessionId={SESSION} run={n.agentErrorRun} />)}</>);
      console.log('POLL_FAILURE_CARDS_RAW',screen.queryAllByRole('alert').length);
      expect(screen.queryAllByRole('alert').length).toBeLessThanOrEqual(1);
    });
    it('real user Stop with an unrelated completed task in the turn preserves the stopped row',() => {
      useBackgroundTaskStore.setState({ tasks: [task('completed','unrelated')] });
      const messages: Message[]=[
        { id: 'user',role: 'user',content: '检查项目',timestamp: 1 },
        { id: 'stop',role: 'assistant',content: '[cancelled]',timestamp: 3,metadata: { streamInterruptionReason: 'user' } },
      ];
      const nodes=projectTurns(messages,SESSION,false).turns.flatMap(turn => turn.nodes);
      console.log('REAL_STOP_RAW',JSON.stringify(nodes));
      expect(nodes.some(n => n.metadata?.streamInterruptionReason==='user')).toBe(true);
      render(<>{nodes.map(n => <TraceNodeRenderer key={n.id} node={n} sessionId={SESSION} />)}</>);
      expect(document.body.textContent).toContain('你停止了这次执行');
    });
    it('consumers delegate terminal decisions and contain no local stale derivation',() => {
      const root='src/renderer/';
      for(const file of ['components/features/chat/ToolStepGroup.tsx','components/features/chat/TraceNodeRenderer.tsx','components/features/chat/MessageBubble/ToolCallDisplay/styles.ts','components/features/chat/MessageBubble/ToolCallDisplay/index.tsx','utils/bareInterruptionNode.ts']) {
        const text=readFileSync(`${root}${file}`,'utf8');
        // styles.ts only maps a resolved status to colours: it must not see a tool call at all.
        if(file.endsWith('styles.ts')) expect(text,file).not.toMatch(/\btoolCall\b|\.result\b|processingSessionIds/);
        else expect(text,file).toMatch(/resolveToolCallTerminalState|traceTerminalToolCall/);
        expect(text,file).not.toMatch(/isStaleUnfinishedToolCall|return isProcessing \? 'pending' : 'interrupted'|\.result\s*===\s*undefined[^;\n]*['"]interrupted['"]|toolCall\.result === undefined && !sessionLive/);
      }
    });
  });

});

describe('toolRowAgentTreePolling',() => {
  const SESSION='history-session';
  const ROWS=20;
  const POLL_MS=3000;

  function traceNode(i: number,settled: boolean,agentId?: string): TraceNode {
    return {
      id: `node-${i}`,type: 'tool_call',content: '',timestamp: i+1,
      metadata: agentId? { agentTeam: { sessionId: SESSION,runId: 'child-run',treeId: 'tree',agentId } }:undefined,
      toolCall: { id: `group-call-${i}`,name: 'Bash',args: { command: `echo ${i}` },...(settled? { result: 'ok',success: true }:{}) }
    };
  }
  function toolCall(i: number,settled: boolean,name='Bash'): ToolCall {
    return {
      id: `row-call-${i}`,name,arguments: { command: `echo ${i}` },
      result: settled? { toolCallId: `row-call-${i}`,success: true,output: 'ok' }:undefined
    };
  }
  function treeCalls(spy: { mock: { calls: readonly (readonly unknown[])[] } }): number {
    return spy.mock.calls.filter(call => call[0]===IPC_DOMAINS.AGENT&&call[1]==='getTree').length;
  }
  function spyTree(status='completed') {
    return vi.spyOn(ipcService,'invokeDomain').mockImplementation(((domain: string,action: string) => Promise.resolve(
      domain===IPC_DOMAINS.AGENT&&action==='getTree'? {
        generatedAt: 5,sessionId: SESSION,roots: [],
        nodes: [{
          id: 'child',role: 'explore',status,statusLabel: status,children: [],sources: ['subagentContext'],
          worktreeState: { status: 'none' },budgetSummary: {},evidenceRefs: []
        }],
        summary: { ownershipConflicts: [] }
      }:null)) as never);
  }
  async function tick(times: number) {
    for(let i=0;i<times;i++) await act(async () => { vi.advanceTimersByTime(POLL_MS); });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval','clearInterval'] });
    useAppStore.setState({ language: 'zh',processingSessionIds: new Set(),pendingPermissionRequest: null,pendingPermissionSessionId: null,queuedPermissionRequests: {} });
    useSessionStore.setState({ currentSessionId: SESSION,messages: [],runningSessionIds: new Set() });
    useBackgroundTaskStore.setState({ tasks: [] });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  describe('tool rows share one agent-tree poll per session',() => {
    it.each([
      ['settled',true],
      ['result-less main-session (historical interrupted)',false],
    ] as const)(`${ROWS} %s ToolStepGroup + ToolCallDisplay rows start no agent-tree poll`,async (_name,settled) => {
      const spy=spyTree();
      render(<>
        <ToolStepGroup nodes={Array.from({ length: ROWS },(_,i) => traceNode(i,settled))} sessionId={SESSION} defaultExpanded />
        {Array.from({ length: ROWS },(_,i) => <ToolStepGroup key={`g${i}`} nodes={[traceNode(100+i,settled)]} sessionId={SESSION} />)}
        {Array.from({ length: ROWS },(_,i) => <ToolCallDisplay key={`r${i}`} toolCall={toolCall(i,settled)} index={i} total={ROWS} />)}
      </>);
      await tick(3);
      console.log('AGENT_TREE_POLLS_RAW',_name,'rows',ROWS*3,'getTree',treeCalls(spy));
      expect(treeCalls(spy)).toBe(0);
    });

    it(`${ROWS} result-less agent-owned rows share one poll, still settle from the agent row, and stop on unmount`,async () => {
      const spy=spyTree('completed');
      const view=render(<>
        {Array.from({ length: ROWS },(_,i) => <ToolStepGroup key={`g${i}`} nodes={[traceNode(i,false,'child')]} sessionId={SESSION} defaultExpanded />)}
      </>);
      await waitFor(() => expect(document.body.textContent).not.toContain('已中断'));
      console.log('AGENT_TREE_POLLS_RAW','agent-owned mount','getTree',treeCalls(spy));
      expect(treeCalls(spy)).toBe(1);
      await tick(3);
      console.log('AGENT_TREE_POLLS_RAW','agent-owned after 3 intervals','getTree',treeCalls(spy));
      expect(treeCalls(spy)).toBe(4);
      view.unmount();
      await tick(3);
      expect(treeCalls(spy)).toBe(4);
    });

    it(`${ROWS} dispatch rows that read the agent tree share one poll`,async () => {
      const spy=spyTree('running');
      render(<>{Array.from({ length: ROWS },(_,i) => <ToolCallDisplay key={i} toolCall={toolCall(i,true,'spawn_agent')} index={i} total={ROWS} />)}</>);
      await tick(3);
      console.log('AGENT_TREE_POLLS_RAW','dispatch rows','getTree',treeCalls(spy));
      expect(treeCalls(spy)).toBe(4);
    });
  });

});

describe('delegationDispatchStatus',() => {
  const SESSION='dispatch-session';
  const AGENT='agent_explore_1';
  const SPINNER=/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
  type Icon='spinner'|'success'|'error'|'interrupted';

  function task(status: Task['status']): Task {
    return {
      id: 'task-1',source: 'session_command_center',sessionId: SESSION,toolCallId: 'delegate-call',
      title: '核对发布清单',status,createdAt: 1,updatedAt: 5,events: [],outputRefs: []
    };
  }
  // The result of a delegation call is the dispatch receipt, not the outcome of the delegated work.
  function delegateCall(result: Partial<NonNullable<ToolCall['result']>>={}): ToolCall {
    return {
      id: 'delegate-call',name: 'delegate_task',arguments: { description: '核对发布清单' },
      result: { toolCallId: 'delegate-call',success: true,output: 'accepted',...result }
    };
  }
  function spawnCall(): ToolCall {
    return {
      id: 'spawn-call',name: 'spawn_agent',arguments: { role: 'explore',task: '核对发布清单',run_in_background: true },
      result: { toolCallId: 'spawn-call',success: true,output: `- Agent ID: ${AGENT}`,metadata: { agentId: AGENT } }
    };
  }
  function spyTree(status: AgentTreeNodeStatus) {
    vi.spyOn(ipcService,'invokeDomain').mockImplementation(((domain: string,action: string) => Promise.resolve(
      domain===IPC_DOMAINS.AGENT&&action==='getTree'? {
        generatedAt: 5,sessionId: SESSION,roots: [],
        nodes: [{
          id: AGENT,role: 'explore',status,statusLabel: status,children: [],sources: ['spawnGuard'],
          worktreeState: { status: 'none' },budgetSummary: {},evidenceRefs: []
        }],
        summary: { ownershipConflicts: [] }
      }:null)) as never);
  }
  /** The row's own status icon: the first cell of the row, ahead of the title. */
  function icon(toolName: string): Icon {
    const text=screen.getByTestId(`tool-call-row-${toolName}`).firstElementChild?.textContent??'';
    return SPINNER.test(text)? 'spinner':text==='✗'? 'error':text==='⊘'? 'interrupted':text==='●'? 'success':(`unexpected:${text}` as Icon);
  }

  beforeEach(() => {
    useAppStore.setState({ language: 'zh',processingSessionIds: new Set(),pendingPermissionRequest: null,pendingPermissionSessionId: null,queuedPermissionRequests: {} });
    useSessionStore.setState({ currentSessionId: SESSION,messages: [],runningSessionIds: new Set() });
    useBackgroundTaskStore.setState({ tasks: [] });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); useBackgroundTaskStore.setState({ tasks: [] }); });

  describe('a dispatched delegation row follows the delegated work, not the dispatch receipt',() => {
    it.each([
      ['running','spinner'],
      ['queued','spinner'],
      ['failed','error'],
      ['cancelled','interrupted'],
      ['completed','success'],
    ] as const)('background task %s after a successful dispatch shows %s',(status,expected) => {
      useBackgroundTaskStore.setState({ tasks: [task(status)] });
      render(<ToolCallDisplay toolCall={delegateCall()} index={0} total={1} />);
      console.log('DISPATCH_ROW_RAW','delegate_task',status,icon('delegate_task'),'|',screen.getByTestId('tool-call-row-delegate_task').textContent);
      expect(icon('delegate_task')).toBe(expected);
    });

    it.each([
      ['running','spinner'],
      ['failed','error'],
      ['completed','success'],
    ] as const)('sub-agent %s after a successful dispatch shows %s',async (status,expected) => {
      spyTree(status);
      render(<ToolCallDisplay toolCall={spawnCall()} index={0} total={1} />);
      await waitFor(() => expect(icon('spawn_agent')).toBe(expected));
      console.log('DISPATCH_ROW_RAW','spawn_agent',status,icon('spawn_agent'),'|',screen.getByTestId('tool-call-row-spawn_agent').textContent);
    });

    it.each([
      ['running','spinner'],
      ['failed','error'],
    ] as const)('the same row reached through ToolStepGroup shows %s work as %s',(status,expected) => {
      useBackgroundTaskStore.setState({ tasks: [task(status)] });
      const node: TraceNode={
        id: 'node-delegate',type: 'tool_call',content: '',timestamp: 2,
        toolCall: { id: 'delegate-call',name: 'delegate_task',args: { description: '核对发布清单' },result: 'accepted',success: true }
      };
      render(<ToolStepGroup nodes={[node]} sessionId={SESSION} />);
      console.log('DISPATCH_ROW_RAW','group',status,icon('delegate_task'));
      expect(icon('delegate_task')).toBe(expected);
    });

    it('with no record of the delegated work yet, the dispatch receipt still decides',() => {
      render(<ToolCallDisplay toolCall={delegateCall()} index={0} total={1} />);
      expect(icon('delegate_task')).toBe('success');
      cleanup();
      render(<ToolCallDisplay toolCall={delegateCall({ success: false,output: undefined,error: 'dispatch rejected' })} index={0} total={1} />);
      // A plain failed call renders the quiet failure style: muted dot plus the failure rail on the row wrapper.
      expect(screen.getByTestId('tool-call-row-delegate_task').parentElement?.className).toContain('border-l-2');
    });

    it('a receipt row keeps its own failed outcome even when the call was later recovered',() => {
      const toolCall: ToolCall={
        id: 'mail-call',name: 'mail_send',arguments: { to: 'a@example.com' },
        result: { toolCallId: 'mail-call',success: false,error: 'send rejected',metadata: { recovered: true } }
      };
      render(<ToolCallDisplay toolCall={toolCall} index={0} total={1}
        receipt={{ status: 'failed',sourceTool: 'mail_send',createdAt: 1 }} />);
      const row=screen.getByTestId('tool-call-row-mail_send');
      console.log('RECEIPT_ROW_RAW',row.parentElement?.className.includes('border-l-2')? 'failed-rail':'no-rail','|',row.textContent,
        '| recovered-note',screen.queryAllByTestId('tool-call-recovered-note').length);
      expect(row.textContent).toContain('失败');
      expect(row.parentElement?.className).toContain('border-l-2');
      expect(screen.queryByTestId('tool-call-recovered-note')).toBeNull();
    });

    it('a failure already recovered by a later success stays settled',() => {
      useBackgroundTaskStore.setState({ tasks: [task('failed')] });
      render(<ToolCallDisplay toolCall={delegateCall({ success: false,output: undefined,error: 'first try failed',metadata: { recovered: true } })} index={0} total={1} />);
      expect(icon('delegate_task')).toBe('success');
    });
  });

});

describe('stale running header fixtures',() => {
  // FB-595：回合收尾（会话不在 processingSessionIds）后，无 result 的调用不能再用
  // 进行时渲染——折叠头曾与展开行各说各话（头「运行中 · 正在运行命令 ls …」，行「已中断」）。
  // 这里渲染真实 ToolStepGroup + 真实 app store，钉住两个状态源同一口径：
  // 折叠头文本 === 展开行（resolveToolCallTerminalState → statusLabels / buildToolStatusLineCopy）对同一
  // 调用装配出的那一行。普通失败（Read success:false + 错误结果）的头文案另行回归钉死，
  // 不随陈旧收口改动漂移。

  function staleBashNode(id: string,timestamp: number): TraceNode {
    return {
      id,
      type: 'tool_call',
      content: '',
      timestamp,
      toolCall: {
        id: `${id}-call`,
        name: 'Bash',
        args: { command: 'ls' },
        // 无 result：回合结束时这一步没有落回任何结果
      },
    } as TraceNode;
  }

  function finishedReadNode(id: string,timestamp: number): TraceNode {
    return {
      id,
      type: 'tool_call',
      content: '',
      timestamp,
      toolCall: {
        id: `${id}-call`,
        name: 'Read',
        args: { file_path: '/work/notes.md' },
        success: true,
        result: 'ok',
      },
    } as TraceNode;
  }

  function failedReadNode(id: string,timestamp: number): TraceNode {
    return {
      id,
      type: 'tool_call',
      content: '',
      timestamp,
      toolCall: {
        id: `${id}-call`,
        name: 'Read',
        args: { file_path: '/work/notes.md' },
        success: false,
        result: 'ENOENT: no such file or directory, open /work/notes.md',
      },
    } as TraceNode;
  }

  // 与 ToolStepGroup 展开档（toolCalls memo）同构的 ToolCall 形状，喂给展开行同一批
  // 判定/装配函数（resolveToolCallTerminalState、getToolStatusLabel、buildToolStatusLineCopy）。
  function toolCallOf(node: TraceNode): ToolCall {
    const tc=node.toolCall!;
    return {
      id: tc.id,
      name: tc.name,
      arguments: tc.args,
      shortDescription: tc.shortDescription,
      stepLabel: tc.stepLabel,
      result: tc.result===undefined
        ? undefined
        :{
          toolCallId: tc.id,
          success: tc.success??true,
          output: tc.success!==false? tc.result:undefined,
          error: tc.success===false? tc.result:undefined,
        },
    } as ToolCall;
  }

  const headLabelText=() => screen.getByTestId('tool-group-head-label').textContent??'';

  describe('ToolStepGroup — stale running header (FB-595)',() => {
    afterEach(() => {
      cleanup();
      useAppStore.setState({ processingSessionIds: new Set<string>(),isProcessing: false });
      useSessionStore.setState({ currentSessionId: null });
    });

    it('(a) idle session + result-less Bash: collapsed header equals the expanded-row interrupted line',() => {
      useAppStore.setState({ language: 'zh',processingSessionIds: new Set(),isProcessing: false });
      useSessionStore.setState({ currentSessionId: 'sess-stale-a' });
      const node=staleBashNode('tool-a',1_000);
      render(<ToolStepGroup nodes={[node]} sessionId="sess-stale-a" defaultExpanded />);

      // 展开行的状态判定（共享 resolver，展开行经 useToolCallTerminalResolver 读它）：同一输入必须落到
      // 'interrupted'——这是两个状态源同判定的锚点。
      const tc=toolCallOf(node);
      const expandedStatus=resolveToolCallTerminalState({ toolCall: tc,sessionId: 'sess-stale-a',sessionLive: false }).displayStatus;
      expect(expandedStatus).toBe('interrupted');

      // 展开行的两段文案（statusLabels.ts 的状态词 + ToolHeader 用的同一装配器）
      const t=languages.zh;
      const expandedLabel=getToolStatusLabel(tc,expandedStatus,t);
      const expandedLine=buildToolStatusLineCopy({ status: expandedStatus,toolCall: tc },t);
      expect(expandedLabel).toBe('已中断');
      expect(expandedLine.line).toBe(`${expandedLabel} · ${expandedLine.action}`);

      const header=headLabelText();
      expect(header).not.toContain('运行中');
      expect(header).not.toContain('正在运行命令');
      // 折叠头 === 展开行装配线：同一结局词、同一动作短语、同一句
      expect(header).toBe(expandedLine.line);

      // 真实展开行 DOM（ToolCallDisplay → ToolHeader）确实渲染这两段
      const headerBlock=screen.getByTestId('tool-call-row-Bash').children[1] as HTMLElement;
      const parts=Array.from(headerBlock.children)
        .map((child) => (child.textContent??'').trim())
        .filter(Boolean);
      expect(parts[0]).toBe(`${expandedLabel} ·`);
      expect(parts[1]).toBe(expandedLine.action);
    });

    it('(b) live session keeps the running header as today',() => {
      useAppStore.setState({
        language: 'zh',
        processingSessionIds: new Set(['sess-live-b']),
        isProcessing: true,
      });
      render(<ToolStepGroup nodes={[staleBashNode('tool-b',2_000)]} sessionId="sess-live-b" />);
      const text=headLabelText();
      expect(text).toContain('运行中 · ');
      expect(text).toContain('正在运行命令');
    });

    it('(c) mixed group (one finished + one result-less) in an idle session: no running wording',() => {
      useAppStore.setState({ language: 'zh',processingSessionIds: new Set(),isProcessing: false });
      render(
        <ToolStepGroup
          nodes={[finishedReadNode('tool-c1',3_000),staleBashNode('tool-c2',4_000)]}
          sessionId="sess-mixed-c"
        />,
      );
      const text=headLabelText();
      expect(text).not.toContain('运行中');
      expect(text).toContain('已中断');
    });

    it('(d) failed Read (idle session): header keeps the plain failure wording, never the interrupted label',() => {
      useAppStore.setState({ language: 'zh',processingSessionIds: new Set(),isProcessing: false });
      useSessionStore.setState({ currentSessionId: 'sess-readfail-d' });
      render(<ToolStepGroup nodes={[failedReadNode('tool-d',5_000)]} sessionId="sess-readfail-d" />);
      const text=headLabelText();
      // origin/main 的普通失败头：读取 … 未成功（不带错误码——错误码走组头失败原因行，不进步骤行）
      expect(text).toBe('读取 /work/notes.md 未成功');
      expect(text).not.toContain('已中断');
      expect(text).not.toContain('运行中');
    });

    it('(e) failed Read (live session): same failure wording as idle — finished calls ignore liveness',() => {
      useAppStore.setState({
        language: 'zh',
        processingSessionIds: new Set(['sess-readfail-e']),
        isProcessing: true,
      });
      render(<ToolStepGroup nodes={[failedReadNode('tool-e',6_000)]} sessionId="sess-readfail-e" />);
      const text=headLabelText();
      expect(text).toBe('读取 /work/notes.md 未成功');
      expect(text).not.toContain('已中断');
    });
  });

});


describe('shared agent tree preserves live-only polling semantics from main', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([false, true])('reads terminal nodes only for live-only subscribers: %s', async (onlyWhileLive) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const readNodes = vi.fn(() => []);
    const snapshot = { sessionId: 'poll-mode-session', get nodes() { return readNodes(); } };
    const invoke = vi.spyOn(ipcService, 'invokeDomain').mockResolvedValue(snapshot);
    const view = renderHook(() => useAgentTreeSnapshot('poll-mode-session', true, onlyWhileLive));
    await act(async () => {});
    await waitFor(() => expect(view.result.current.snapshot).toBe(snapshot));
    expect(readNodes).toHaveBeenCalledTimes(onlyWhileLive ? 1 : 0);
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(invoke).toHaveBeenCalledTimes(onlyWhileLive ? 1 : 2);
  });
});
