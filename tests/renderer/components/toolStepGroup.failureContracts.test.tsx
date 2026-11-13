// @vitest-environment jsdom
// Related row contracts share a file; each suite retains its own store and IPC fixtures.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe,expect,it,vi,afterEach,beforeAll,afterAll } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';

describe('toolFailOneline',() => {
  let ToolCallDisplay: typeof import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay')['ToolCallDisplay'];
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
      }) => unknown) => selector({
        processingSessionIds: new Set(),
        openPreview: vi.fn(),
        pendingPermissionRequest: null,
        pendingPermissionSessionId: null,
        queuedPermissionRequests: [],
      });
      return { useAppStore: Object.assign(useAppStore,{ getState: () => useAppStore((state) => state) }) };
    });
    vi.doMock('../../../src/renderer/stores/sessionStore',() => ({
      useSessionStore: (selector: (state: { currentSessionId: string }) => unknown) => (
        selector({ currentSessionId: 'session-1' })
      ),
    }));
    vi.doMock('../../../src/renderer/stores/backgroundTaskStore',() => ({
      useBackgroundTaskStore: (selector: (state: { tasks: [] }) => unknown) => selector({ tasks: [] }),
    }));
    vi.doMock('../../../src/renderer/hooks/useAgentTreeSnapshot',() => ({
      useAgentTreeSnapshot: () => ({ snapshot: null,refresh: vi.fn() }),
    }));
    ToolCallDisplay=(await import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay')).ToolCallDisplay;
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


  function spawnWorktreeFailCall(): ToolCall {
    return {
      id: 'spawn-1',
      name: 'spawn_agent',
      arguments: { description: '核对清单' },
      result: {
        toolCallId: 'spawn-1',
        success: false,
        error: 'Failed to create worktree for agent: dummy. Inspect worktree setup and resolve its error before retrying.',
        metadata: { failureCode: 'worktree-create-failed' },
      },
    };
  }


  describe('工具失败行一句人话',() => {
    it('spawn_agent worktree 失败行只显示一句人话原因，不叠四层文案',() => {
      const html=renderToStaticMarkup(
        <ToolCallDisplay toolCall={spawnWorktreeFailCall()} index={0} total={1} />,
      );
      const reason=zh.toolStepHumanize.failureCodes['worktree-create-failed'];
      expect(html).toContain(reason);
      expect(html).not.toContain(zh.toolStepHumanize.failureReasonMissing);
      expect(html).not.toContain(zh.systemError.fallbackSummary);
      expect((html.match(new RegExp(reason,'g'))??[]).length).toBe(1);
    });

    it('ToolStepGroup 组头失败 reason 与右侧摘要去重',() => {
      const node: TraceNode={
        id: 'tool-1',
        type: 'tool_call',
        content: '',
        timestamp: 1,
        toolCall: {
          id: 'call-1',
          name: 'Bash',
          args: {},
          success: false,
          result: 'command failed with exit code 1',
          metadata: { failureCode: 'worktree-create-failed' },
        },
      };
      const html=renderToStaticMarkup(<ToolStepGroup nodes={[node]} />);
      const reason=zh.toolStepHumanize.failureCodes['worktree-create-failed'];
      expect(html).toContain(reason);
      expect(html).not.toContain(zh.toolStepHumanize.failureReasonMissing);
      expect(html).not.toContain(zh.systemError.fallbackSummary);
    });
  });
});

describe('toolStepGroup.failCollapse',() => {
  let ToolStepGroup: typeof import('../../../src/renderer/components/features/chat/ToolStepGroup')['ToolStepGroup'];
  let ToolDetails: typeof import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails')['ToolDetails'];
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
    ToolStepGroup=(await import('../../../src/renderer/components/features/chat/ToolStepGroup')).ToolStepGroup;
    ToolDetails=(await import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails')).ToolDetails;
  });
  afterAll(() => {
    vi.doUnmock('../../../src/renderer/hooks/useI18n');
    vi.doUnmock('../../../src/renderer/stores/appStore');
    vi.resetModules();
  });


  let nid=0;

  function toolNode(name: string,success: boolean,result?: string): TraceNode {
    nid+=1;
    return {
      id: `tool-${nid}`,
      type: 'tool_call',
      content: '',
      timestamp: nid,
      toolCall: {
        id: `call-${nid}`,
        name,
        args: { url: `https://site${nid}.com` },
        success,
        result: result??(success? 'ok':'anti-scraping wall'),
      },
    } as TraceNode;
  }


  // 展开态才会渲染的内层容器（每工具 ToolCallDisplay 列表的 border-l 框）
  const EXPANDED_MARKER='border-l border-zinc-800';


  describe('ToolStepGroup — 探索性失败默认折叠，需介入的失败默认展开+顶红',() => {
    it('部分失败（partial：有成功有反爬失败，未分类错误）默认折叠，不撑开报错墙',() => {
      const html=renderToStaticMarkup(
        <ToolStepGroup nodes={[toolNode('WebFetch',false),toolNode('WebFetch',true)]} />,
      );
      expect(html).not.toContain(EXPANDED_MARKER);
    });

    it('全失败（error，未分类错误）默认也折叠',() => {
      const html=renderToStaticMarkup(
        <ToolStepGroup nodes={[toolNode('WebFetch',false),toolNode('WebFetch',false)]} />,
      );
      expect(html).not.toContain(EXPANDED_MARKER);
    });

    it('defaultExpanded=true 时仍展开（流式态等显式要求不受影响）',() => {
      const html=renderToStaticMarkup(
        <ToolStepGroup nodes={[toolNode('WebFetch',true),toolNode('WebFetch',true)]} defaultExpanded />,
      );
      expect(html).toContain(EXPANDED_MARKER);
    });

    it('非网络工具（Bash 非零退出码，未分类错误）的探索性失败也默认折叠，不顶红',() => {
      const html=renderToStaticMarkup(
        <ToolStepGroup nodes={[toolNode('Bash',false,'command failed with exit code 1')]} />,
      );
      expect(html).not.toContain(EXPANDED_MARKER);
      expect(html).not.toContain('border border-white/[0.04]');
      expect(html).not.toContain('bg-white/[0.015]');
      expect(html).toContain('px-1 py-0.5 text-zinc-400');
      expect(html).not.toContain('bg-mark-danger');
      expect(html).not.toContain('text-badge-danger');
    });

    it('探索性失败的原始报错仅在用户主动展开后显示',() => {
      // 组折叠只影响"要不要强制摊开"，不影响每个工具自己被点开后展示的内容——
      // ToolDetails 是点开单个工具行后挂载的详情视图，验证它没有被本批改动阉割信息。
      const html=renderToStaticMarkup(
        React.createElement(ToolDetails,{
          toolCall: {
            id: 'call-x',
            name: 'Bash',
            arguments: {},
            result: { toolCallId: 'call-x',success: false,error: 'command failed with exit code 1' },
          },
        }),
      );
      expect(html).toContain('查看原始报错');
      expect(html).not.toContain('command failed with exit code 1');
    });

    it('真正需要用户介入的失败（鉴权失效）默认展开并顶红',() => {
      const html=renderToStaticMarkup(
        <ToolStepGroup nodes={[toolNode('Bash',false,'401 Unauthorized: invalid api key')]} />,
      );
      expect(html).toContain(EXPANDED_MARKER);
      expect(html).toContain('bg-mark-danger');
      expect(html).toContain('text-badge-danger');
      expect(html).toContain('border-badge-danger/30');
      expect(html).toContain('bg-red-400/[0.05]');
    });

    it('需要用户介入的额度耗尽失败也默认展开并顶红',() => {
      const html=renderToStaticMarkup(
        <ToolStepGroup nodes={[toolNode('image_generate',false,'402 Payment Required: insufficient balance 余额不足')]} />,
      );
      expect(html).toContain(EXPANDED_MARKER);
      expect(html).toContain('bg-mark-danger');
      expect(html).toContain('text-badge-danger');
      expect(html).toContain('border-badge-danger/30');
      expect(html).toContain('bg-red-400/[0.05]');
    });
  });


  describe('ToolStepGroup — 连接器组头与步骤行说人话',() => {
    function tmeetNode(
      name: 'tmeetMeetingList'|'tmeetMeetingCreate'|'tmeetMeetingSearch',
      stepLabel: 'tmeetMeetingListUpcoming'|'tmeetMeetingListEnded'|'tmeetMeetingCreate'|'tmeetMeetingSearch',
      args: Record<string,unknown>={},
    ): TraceNode {
      nid+=1;
      return {
        id: `tmeet-tool-${nid}`,
        type: 'tool_call',
        content: '',
        timestamp: nid,
        toolCall: {
          id: `tmeet-call-${nid}`,
          name,
          args,
          shortDescription: `Use ${name}`,
          stepLabel,
          success: true,
          result: 'ok',
        },
      };
    }

    it('单步组头直接给连接器名和 scope 对应的人话句',() => {
      const html=renderToStaticMarkup(
        <ToolStepGroup nodes={[
          tmeetNode('tmeetMeetingList','tmeetMeetingListEnded',{ scope: 'ended' }),
        ]} />,
      );

      expect(html).toContain('腾讯会议 · 查了近 30 天已结束的会议');
      expect(html).not.toContain('tmeetMeetingList');
    });

    it.each([
      ['list_calendars','日历 · 查询了可用列表'],
      ['list_events','日历 · 查询了日程'],
    ] as const)('原生日历 %s：前缀已渲染时名字只出现一次且动作可区分',(action,expected) => {
      const node=toolNode('calendar',true);
      if(node.toolCall) node.toolCall.args={ action };
      const html=renderToStaticMarkup(<ToolStepGroup nodes={[node]} />);

      expect(html).toContain(expected);
      expect(html.match(/日历/gu)).toHaveLength(1);
      expect(html).not.toContain('执行了操作');
    });

    it.each([
      ['calendar_create_event','日历 · 创建了日程'],
      ['calendar_update_event','日历 · 修改了日程'],
      ['calendar_delete_event','日历 · 删除了日程'],
    ] as const)('原生日历写动作 %s：复用既有动作派生',(name,expected) => {
      const html=renderToStaticMarkup(<ToolStepGroup nodes={[toolNode(name,true)]} />);
      expect(html).toContain(expected);
      expect(html.match(/日历/gu)).toHaveLength(1);
    });

    it('多步组头只给连接器名和步骤数',() => {
      const html=renderToStaticMarkup(
        <ToolStepGroup nodes={[
          tmeetNode('tmeetMeetingList','tmeetMeetingListUpcoming'),
          tmeetNode('tmeetMeetingSearch','tmeetMeetingSearch'),
        ]} />,
      );

      expect(html).toContain('腾讯会议 · 执行了 2 个步骤');
      expect(html).not.toMatch(/tmeetMeeting(List|Search)/);
    });

    it('语义 UI 门关闭时，连接器组头仍不回退到内部名',() => {
      vi.stubGlobal('window',{
        localStorage: { getItem: (key: string) => key==='cca.semanticToolUI'? 'false':null },
      });
      try {
        const html=renderToStaticMarkup(
          <ToolStepGroup nodes={[
            tmeetNode('tmeetMeetingCreate','tmeetMeetingCreate'),
          ]} />,
        );
        expect(html).toContain('腾讯会议 · 创建了一场会议');
        expect(html).not.toContain('tmeetMeetingCreate');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('非连接器继续使用现有人话模板',() => {
      const html=renderToStaticMarkup(
        <ToolStepGroup nodes={[toolNode('Read',true)]} />,
      );
      expect(html).toContain('读取了一个文件');
      expect(html).not.toContain('Read 执行了一个步骤');
    });
  });
});

describe('toolStepGroup.threeState',() => {
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
          processingSessionIds: new Set(),
        });
      return { useAppStore: Object.assign(useAppStore,{ getState: () => useAppStore((state) => state) }) };
    });
    ToolStepGroup=(await import('../../../src/renderer/components/features/chat/ToolStepGroup')).ToolStepGroup;
  });
  afterAll(() => {
    vi.doUnmock('../../../src/renderer/hooks/useI18n');
    vi.doUnmock('../../../src/renderer/stores/appStore');
    vi.resetModules();
  });


  afterEach(() => {
    cleanup();
  });


  let nid=0;

  function runningNode(name: string): TraceNode {
    nid+=1;
    return {
      id: `tool-${nid}`,
      type: 'tool_call',
      content: '',
      timestamp: nid,
      toolCall: {
        id: `call-${nid}`,
        name,
        args: {},
        // 无 result = 运行中（真实"正在跑"信号，非 _streaming 参数流标记）
      },
    } as TraceNode;
  }


  function doneNode(name: string,success=true,result='ok'): TraceNode {
    nid+=1;
    return {
      id: `tool-${nid}`,
      type: 'tool_call',
      content: '',
      timestamp: nid,
      toolCall: {
        id: `call-${nid}`,
        name,
        args: {},
        success,
        result,
      },
    } as TraceNode;
  }


  function runningNodeWithLiveOutput(name: string,stdoutLines: string[]): TraceNode {
    nid+=1;
    return {
      id: `tool-${nid}`,
      type: 'tool_call',
      content: '',
      timestamp: nid,
      toolCall: {
        id: `call-${nid}`,
        name,
        args: {},
        liveOutput: { stdout: stdoutLines.join('\n') },
      },
    } as TraceNode;
  }


  const EXPANDED_MARKER='border-l border-zinc-800';


  describe('ToolStepGroup 三态折叠预览（ADR-043 T2）',() => {
    it('① 流式中未手动操作 → 渲染中间档：运行中那步可见 + 已完成计数行',() => {
      render(
        <ToolStepGroup
          nodes={[doneNode('Read'),doneNode('Read'),runningNode('Bash')]}
          isStreamingTurn
        />,
      );
      // 运行中那步（Bash）以 compact 行渲染出来
      expect(screen.getByTestId('tool-call-row-Bash')).toBeTruthy();
      // 已完成 2 步的计数行
      expect(screen.getByText('已完成 2 步')).toBeTruthy();
      // 未进入全展开：不出现全展开专属容器
      expect(document.body.innerHTML).not.toContain(EXPANDED_MARKER);
    });

    it('② 流式结束 → 自动回收起（不再渲染运行中预览/计数行）',() => {
      const { rerender }=render(
        <ToolStepGroup nodes={[doneNode('Read'),runningNode('Bash')]} isStreamingTurn />,
      );
      expect(screen.getByTestId('tool-call-row-Bash')).toBeTruthy();

      // 流式收尾：这一步也跑完了，isStreamingTurn 降为 false
      rerender(
        <ToolStepGroup nodes={[doneNode('Read'),doneNode('Bash')]} isStreamingTurn={false} />,
      );
      expect(screen.queryByTestId('tool-call-row-Bash')).toBeNull();
      expect(screen.queryByText(/已完成 \d+ 步/)).toBeNull();
    });

    it('③a 用户手动点开后冻结自动档：流式中点开保持展开，即便流式结束也不缩回中间档/收起',() => {
      const { rerender }=render(
        <ToolStepGroup nodes={[doneNode('Read'),runningNode('Bash')]} isStreamingTurn />,
      );
      // 组头按钮永远是文档序里第一个 button（内层运行中工具行也是 role=button，取第一个才是组头）
      const button=screen.getAllByRole('button')[0] as HTMLElement;
      fireEvent.click(button);
      expect(document.body.innerHTML).toContain(EXPANDED_MARKER);

      // 流式结束，若未冻结会被自动收起——冻结后应仍保持全展开
      rerender(
        <ToolStepGroup nodes={[doneNode('Read'),doneNode('Bash')]} isStreamingTurn={false} />,
      );
      expect(document.body.innerHTML).toContain(EXPANDED_MARKER);
    });

    it('③b 用户手动点收后冻结：流式中点收保持收起，不再被自动中间档抢回',() => {
      render(
        <ToolStepGroup
          nodes={[doneNode('Read'),runningNode('Bash')]}
          isStreamingTurn
          defaultExpanded
        />,
      );
      // defaultExpanded=true 起始为全展开态
      expect(document.body.innerHTML).toContain(EXPANDED_MARKER);
      const button=screen.getAllByRole('button')[0] as HTMLElement;
      fireEvent.click(button);
      // 点收后：既不是全展开，也不该被中间档接管（用户已冻结）
      expect(document.body.innerHTML).not.toContain(EXPANDED_MARKER);
      expect(screen.queryByTestId('tool-call-row-Bash')).toBeNull();
    });

    it('④ 需介入失败 → 直接全展开，不进中间档（即便仍在流式中）',() => {
      render(
        <ToolStepGroup
          nodes={[doneNode('Bash',false,'401 Unauthorized: invalid api key')]}
          isStreamingTurn
        />,
      );
      expect(document.body.innerHTML).toContain(EXPANDED_MARKER);
      expect(document.body.innerHTML).toContain('bg-mark-danger');
    });

    it('⑤ 探索性失败 → 保持收起，不因流式中而进中间档',() => {
      render(
        <ToolStepGroup
          nodes={[doneNode('WebFetch',false,'anti-scraping wall'),runningNode('Bash')]}
          isStreamingTurn
        />,
      );
      expect(document.body.innerHTML).not.toContain(EXPANDED_MARKER);
      expect(screen.queryByTestId('tool-call-row-Bash')).toBeNull();
      expect(screen.queryByText(/已完成 \d+ 步/)).toBeNull();
    });

    it('⑥ 中间档时 aria-expanded=false（未全展开语义不变）',() => {
      render(<ToolStepGroup nodes={[doneNode('Read'),runningNode('Bash')]} isStreamingTurn />);
      const button=screen.getAllByRole('button')[0] as HTMLElement;
      expect(button.getAttribute('aria-expanded')).toBe('false');
    });

    it('⑦ 计数行 N=0 时不渲染（全部工具都在运行/无已完成步骤）',() => {
      render(<ToolStepGroup nodes={[runningNode('Bash')]} isStreamingTurn />);
      expect(screen.getByTestId('tool-call-row-Bash')).toBeTruthy();
      expect(screen.queryByText(/已完成 \d+ 步/)).toBeNull();
    });

    it('⑧ 中间档实时输出截尾 5 行（拍板决策 4）：早期行不见，末尾行仍在',() => {
      const stdoutLines=Array.from({ length: 20 },(_,i) => `line${i+1}`);
      render(
        <ToolStepGroup nodes={[runningNodeWithLiveOutput('Bash',stdoutLines)]} isStreamingTurn />,
      );
      // 尾 5 行（line16~line20）应该在
      for(let i=16;i<=20;i+=1) {
        expect(screen.queryByText(new RegExp(`line${i}\\b`))).not.toBeNull();
      }
      // 早期行（line1~line15）应该被截掉，不再出现在 DOM 里
      for(let i=1;i<=15;i+=1) {
        expect(document.body.innerHTML).not.toMatch(new RegExp(`line${i}(?!\\d)`));
      }
    });

    it('⑧b 全展开态也走 LiveToolOutput 全局尾截断（遗留刀1）：早期行不见，末尾行仍在',() => {
      const stdoutLines=Array.from({ length: 20 },(_,i) => `line${i+1}`);
      render(
        <ToolStepGroup
          nodes={[runningNodeWithLiveOutput('Bash',stdoutLines)]}
          isStreamingTurn={false}
          defaultExpanded
        />,
      );
      expect(document.body.innerHTML).toContain(EXPANDED_MARKER);
      // 尾 5 行（line16~line20）应该在
      for(let i=16;i<=20;i+=1) {
        expect(document.body.innerHTML).toMatch(new RegExp(`line${i}\\b`));
      }
      // 早期行（line1~line15）应该被截掉，不再出现在 DOM 里
      for(let i=1;i<=15;i+=1) {
        expect(document.body.innerHTML).not.toMatch(new RegExp(`line${i}(?!\\d)`));
      }
    });

    it('⑨ 中间档运行中途出现需介入失败（rerender）→ 立刻切到全展开，不停留在中间档',() => {
      const { rerender }=render(
        <ToolStepGroup nodes={[doneNode('Read'),runningNode('Bash')]} isStreamingTurn />,
      );
      // 起点：中间档
      expect(screen.getByTestId('tool-call-row-Bash')).toBeTruthy();
      expect(document.body.innerHTML).not.toContain(EXPANDED_MARKER);

      // 流式中途：Bash 那步以需介入失败收尾（同一 turn 仍在流式中）
      rerender(
        <ToolStepGroup
          nodes={[doneNode('Read'),doneNode('Bash',false,'401 Unauthorized: invalid api key')]}
          isStreamingTurn
        />,
      );
      expect(document.body.innerHTML).toContain(EXPANDED_MARKER);
      // Read 成功 + Bash 需介入失败 = partial 态，顶色是 amber（error 态才是 red）
      expect(document.body.innerHTML).toContain('bg-mark-warning');
    });
  });
});
