// @vitest-environment jsdom
// Related row contracts share a file; each suite retains its own store and IPC fixtures.
import React from 'react';
import { cleanup,render,fireEvent,screen } from '@testing-library/react';
import { afterEach,describe,expect,it,vi,beforeAll,afterAll } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import type { ToolCall } from '../../../src/shared/contract';
import { describeParkedApprovalClosure } from '../../../src/host/agent/parkedApprovalSurvival';
import { renderToStaticMarkup } from 'react-dom/server';
import { humanizeToolFailureReason } from '../../../src/renderer/utils/toolExecutionPresentation';

describe('delegateSessionReceipt',() => {
  let ToolStepGroup: typeof import('../../../src/renderer/components/features/chat/ToolStepGroup')['ToolStepGroup'];
  let ToolCallDisplay: typeof import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay')['ToolCallDisplay'];
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('../../../src/renderer/hooks/useI18n',() => ({ useI18n: () => ({ t: mocks.language==='zh'? zh:en }) }));
    vi.doMock('../../../src/renderer/hooks/useAgentTreeSnapshot',() => ({ useAgentTreeSnapshot: (...args: unknown[]) => { mocks.tree(...args); return { snapshot: null }; } }));
    vi.doMock('../../../src/renderer/stores/backgroundTaskStore',() => ({ useBackgroundTaskStore: (select: (s: unknown) => unknown) => select({ tasks: [] }) }));
    vi.doMock('../../../src/renderer/stores/sessionStore',() => ({ useSessionStore: (select: (s: unknown) => unknown) => select({ currentSessionId: 'session' }) }));
    vi.doMock('../../../src/renderer/stores/appStore',() => {
      const useAppStore=(select: (s: unknown) => unknown) => select({ processingSessionIds: new Set(),queuedPermissionRequests: {},pendingPermissionRequest: null });
      return { useAppStore: Object.assign(useAppStore,{ getState: () => useAppStore((s) => s) }) };
    });
    ToolStepGroup=(await import('../../../src/renderer/components/features/chat/ToolStepGroup')).ToolStepGroup;
    ToolCallDisplay=(await import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay')).ToolCallDisplay;
  });
  afterAll(() => {
    vi.doUnmock('../../../src/renderer/hooks/useI18n');
    vi.doUnmock('../../../src/renderer/hooks/useAgentTreeSnapshot');
    vi.doUnmock('../../../src/renderer/stores/backgroundTaskStore');
    vi.doUnmock('../../../src/renderer/stores/sessionStore');
    vi.doUnmock('../../../src/renderer/stores/appStore');
    vi.resetModules();
  });


  const mocks=(() => ({ language: 'zh' as 'zh'|'en',tree: vi.fn() }))();

  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  const secret='delegation_private-fixture';

  function tool(payload: Record<string,unknown>,action='delegate_existing'): ToolCall {
    return {
      id: 'call',name: 'delegate_session',arguments: { action,candidateSetId: secret,candidateRef: secret,text: secret },result: {
        toolCallId: 'call',success: true,output: JSON.stringify({ delegationId: secret,target: 'Q3 报告',status: 'active',queuedAhead: 0,...payload }),
      }
    };
  }

  for(const locale of ['zh','en'] as const) {
    describe(`rendered delegation receipt (${locale})`,() => {
      it.each([
        [{},'delegate_existing','已把任务交给「Q3 报告」','Sent the task to “Q3 报告”'],
        [{ reused: true },'delegate_existing','已送达过，未重复发送 · 「Q3 报告」','Already delivered; not sent again · “Q3 报告”'],
        [{},'create_new','已新建对话「Q3 报告」并交给它','Created conversation “Q3 报告” and sent it the task'],
        [{ target: null },'delegate_existing','已把任务交给另一个对话','Sent the task to another conversation'],
      ] as const)('shows the receipt card %j / %s',(payload,action,chinese,english) => {
        mocks.language=locale;
        const view=render(<ToolCallDisplay toolCall={tool(payload,action)} index={0} total={1} />);
        const expected=locale==='zh'? chinese:english;
        expect(view.getByText(expected)).toBeTruthy();
        expect(view.getByTestId('delegation-receipt')).toBeTruthy();
        expect(view.container.textContent).not.toMatch(/delegation_private-fixture|active|reused|candidateSetId|delegate_session/);
        expect(mocks.tree).toHaveBeenCalledWith('session',false);
      });
      it('routes a single trace receipt through the delegation card',() => {
        mocks.language=locale;
        const tc=tool({ reused: true });
        const node: TraceNode={
          id: tc.id,messageId: 'message',type: 'tool_call',content: '',timestamp: 1,
          toolCall: { id: tc.id,name: tc.name,args: tc.arguments,result: tc.result!.output,success: true }
        };
        const view=render(<ToolStepGroup nodes={[node]} sessionId="session" />);
        expect(view.getByTestId('delegation-receipt')).toBeTruthy();
        expect(view.container.textContent).toContain(locale==='zh'? '已送达过，未重复发送 · 「Q3 报告」':'Already delivered; not sent again · “Q3 报告”');
        expect(view.container.textContent).not.toMatch(/delegation_private-fixture|active|reused|candidateSetId|delegate_session/);
      });
      it('renders candidate lookup without raw output references',() => {
        mocks.language=locale;
        const tc: ToolCall={ ...tool({}),name: 'list_session_candidates' };
        tc.result!.output=JSON.stringify({ candidateSetId: secret,candidates: [{ candidateRef: secret }] });
        const view=render(<ToolCallDisplay toolCall={tc} index={0} total={1} />);
        expect(view.getByText(locale==='zh'? '已查找可委托的对话':'Found conversations for delegation')).toBeTruthy();
        expect(view.container.textContent).not.toMatch(/delegation_private-fixture|active|reused|candidateSetId|delegate_session/);
      });
      it('keeps a rejection out of the success card and its code out of the title',() => {
        mocks.language=locale;
        const tc=tool({}); tc.result!.success=false; tc.result!.error='invalid_call: Nothing was delegated';
        const view=render(<ToolCallDisplay toolCall={tc} index={0} total={1} />);
        expect(view.queryByTestId('delegation-receipt')).toBeNull();
        const title=view.getByTestId('tool-call-row-delegate_session').textContent;
        expect(title).not.toMatch(/invalid_call|code:/);
      });
    });
  }
});

describe('toolCallDisplay.keyboard',() => {
  let ToolCallDisplay: typeof import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay')['ToolCallDisplay'];
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('../../../src/renderer/stores/appStore',() => {
      const state={
        processingSessionIds: new Set<string>(),
        openPreview,
        workingDirectory: '/repo',
        language: 'en' as const,
        setLanguage: vi.fn(),
        cloudUIStrings: undefined,
      };
      return {
        useAppStore: Object.assign((selector?: (value: typeof state) => unknown) =>
          selector? selector(state):state,{ getState: () => state }),
      };
    });
    vi.doMock('../../../src/renderer/stores/sessionStore',() => ({
      useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) =>
        selector({ currentSessionId: 'session-1' }),
    }));
    ToolCallDisplay=(await import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay')).ToolCallDisplay;
  });
  afterAll(() => {
    vi.doUnmock('../../../src/renderer/stores/appStore');
    vi.doUnmock('../../../src/renderer/stores/sessionStore');
    vi.resetModules();
  });


  const openPreview=(() => vi.fn())();


  function makeToolCall(overrides: Partial<ToolCall>={}): ToolCall {
    return {
      id: 'tool-1',
      name: 'Read',
      arguments: { file_path: '/repo/readme.md' },
      result: { toolCallId: 'tool-1',success: true,output: 'done' },
      ...overrides,
    };
  }


  afterEach(() => {
    cleanup();
    openPreview.mockReset();
  });


  describe('ToolCallDisplay keyboard interaction',() => {
    it('puts the row in the Tab order and toggles aria-expanded with Enter and Space',() => {
      const { getByTestId }=render(
        <ToolCallDisplay toolCall={makeToolCall()} index={0} total={1} />,
      );
      const row=getByTestId('tool-call-row-Read');

      expect(row.getAttribute('role')).toBe('button');
      expect(row.getAttribute('tabindex')).toBe('0');
      expect(row.getAttribute('aria-expanded')).toBe('false');

      row.focus();
      fireEvent.keyDown(row,{ key: 'Enter' });
      expect(row.getAttribute('aria-expanded')).toBe('true');

      fireEvent.keyDown(row,{ key: ' ' });
      expect(row.getAttribute('aria-expanded')).toBe('false');
    });

    it('keeps the collapsed result summary on the action row without hover-gated blank space',() => {
      const { container }=render(
        <ToolCallDisplay toolCall={makeToolCall()} index={0} total={1} />,
      );

      expect(container.textContent).toContain('Read 1 lines');
      expect(container.querySelector('.group-focus-within\\:opacity-100')).toBeNull();
      expect(container.querySelector('.opacity-0')).toBeNull();
    });

    it('collapses AskUserQuestion answers to one summary line and expands the existing Q&A',() => {
      const view=render(
        <ToolCallDisplay
          toolCall={makeToolCall({
            name: 'AskUserQuestion',
            arguments: {
              questions: [
                { header: 'Scope',question: 'Which scope?',options: [{ label: 'A',description: '' }] },
                { header: 'Proof',question: 'Which proof?',options: [{ label: 'B',description: '' }] },
              ],
            },
            result: {
              toolCallId: 'tool-1',
              success: true,
              output: 'User responses:\n[Scope]: A\n[Proof]: B',
            },
          })}
          index={0}
          total={1}
        />,
      );

      const summary=view.getByRole('button',{
        name: '2 questions answered · Expand to view',
      });
      expect(summary.getAttribute('aria-expanded')).toBe('false');
      expect(view.queryByText('Which scope?')).toBeNull();

      fireEvent.click(summary);
      expect(summary.getAttribute('aria-expanded')).toBe('true');
      expect(view.getByText('Which scope?')).toBeTruthy();
      expect(view.getByText('Which proof?')).toBeTruthy();
    });

    // 原来这里还有一条「行尾 Write 文件名按钮不触发整行展开」的用例。那个按钮已经删了
    // ——写入的文件名只由文件变更卡讲一遍（它带相对路径 + 增删行数 + diff + 撤销），
    // 步骤行上再挂一个同名按钮是同一个文件名在一屏里的第三次出现。
  });
});

describe('toolCallDisplay.parkedApprovalNotRun',() => {
  let ToolCallDisplay: typeof import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay')['ToolCallDisplay'];
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('../../../src/renderer/stores/appStore',() => {
      const makeState=() => ({
        processingSessionIds: new Set<string>(),
        openPreview: vi.fn(),
        workingDirectory: '/repo',
        language: languageState.value,
        setLanguage: vi.fn(),
        cloudUIStrings: undefined,
      });
      return {
        useAppStore: Object.assign((selector?: (value: ReturnType<typeof makeState>) => unknown) => {
          const state=makeState();
          return selector? selector(state):state;
        },{ getState: makeState }),
      };
    });
    vi.doMock('../../../src/renderer/stores/sessionStore',() => ({
      useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) => (
        selector({ currentSessionId: 'session-1' })
      ),
    }));
    ToolCallDisplay=(await import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay')).ToolCallDisplay;
  });
  afterAll(() => {
    vi.doUnmock('../../../src/renderer/stores/appStore');
    vi.doUnmock('../../../src/renderer/stores/sessionStore');
    vi.resetModules();
  });


  // 语言可切换（真 useI18n 按 appStore.language 选词表）；默认 zh，en 用例临时切换。
  const languageState=(() => ({ value: 'zh' as 'zh'|'en' }))();


  afterEach(cleanup);


  // 台账/收件箱里持久化的是中文原句；英文 UI 按原句精确查表翻成英文。
  const EN_CLOSURE_SENTENCES={
    expiredAfterRestart24h: 'This step waited for your confirmation for over 24 hours, so it was voided automatically and did not run.',
    workingDirectoryUnavailable: "This conversation has no working directory, so it can't be run safely after a restart. It did not run.",
    runEndedAfterRestart: 'The run this step belonged to has already ended, so it did not run; you will be asked again the next time it triggers.',
    argsUnavailable: 'After the app restarted, the full details of this step could not be found, so it was not run for safety.',
  } as const;


  // 老行字面量（不经任何代码产出，模拟重启前落库的历史数据）。
  const LEGACY_ZH_SENTENCES={
    expiredAfterRestart24h: '这一步等你确认超过 24 小时，已自动作废，没有执行。',
    workingDirectoryUnavailable: '这次对话没有工作目录，重启后无法安全执行，没有执行。',
    runEndedAfterRestart: '所属运行已结束，没有执行；下次触发会重新询问你。',
    argsUnavailable: '应用重启后找不到这一步的完整信息，为安全起见没有执行。',
  } as const;


  type ClosureKey=keyof typeof LEGACY_ZH_SENTENCES;


  function parkedToolCall(sentence: string): ToolCall {
    // 形状与 rejectLedgerToolApproval 写入台账的 result 一致：无 metadata。
    return {
      id: 'parked-1',
      name: 'Bash',
      arguments: { command: 'sleep 30' },
      result: { toolCallId: 'parked-1',success: false,error: sentence,duration: 0 },
    };
  }


  describe('ToolCallDisplay 停车审批收口结果',() => {
    describe.each([
      ['host 现写的收口句',(key: ClosureKey) => {
        if(key==='expiredAfterRestart24h') return describeParkedApprovalClosure('expired_after_restart_24h');
        if(key==='workingDirectoryUnavailable') return describeParkedApprovalClosure('args_unavailable','working_directory_unavailable');
        if(key==='runEndedAfterRestart') return describeParkedApprovalClosure('run_ended_after_restart');
        return describeParkedApprovalClosure('args_unavailable');
      }],
      ['老行持久化的中文原句',(key: ClosureKey) => LEGACY_ZH_SENTENCES[key]],
    ] as const)('%s',(_label,sentence) => {
      it.each(Object.keys(LEGACY_ZH_SENTENCES) as ClosureKey[])('%s：折叠态直接读出「未执行 · 原句」',(key) => {
        languageState.value='zh';
        const view=render(<ToolCallDisplay toolCall={parkedToolCall(sentence(key))} index={0} total={1} />);
        const text=view.container.textContent??'';
        expect(text).toContain(`未执行 · ${LEGACY_ZH_SENTENCES[key]}`);
        expect(text).not.toMatch(/执行失败|暂无失败原因摘要|running|运行中/);
      });

      it.each(Object.keys(LEGACY_ZH_SENTENCES) as ClosureKey[])('%s：en UI 折叠态读出「Not run · 英文句」',(key) => {
        languageState.value='en';
        const view=render(<ToolCallDisplay toolCall={parkedToolCall(sentence(key))} index={0} total={1} />);
        const text=view.container.textContent??'';
        expect(text).toContain(`Not run · ${EN_CLOSURE_SENTENCES[key]}`);
        // 台账里的中文原句不再直接上英文 UI 的步骤头
        expect(text).not.toContain(LEGACY_ZH_SENTENCES[key]);
        expect(text).not.toMatch(/Execution failed|failure summary|running|运行中/);
      });
    });
  });
});

describe('toolCallDisplay.recoveredEditRow',() => {
  let ToolCallDisplay: typeof import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay')['ToolCallDisplay'];
  let TraceNodeRenderer: typeof import('../../../src/renderer/components/features/chat/TraceNodeRenderer')['TraceNodeRenderer'];
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('../../../src/renderer/stores/appStore',() => {
      const state={
        processingSessionIds: new Set<string>(),
        openPreview: vi.fn(),
        workingDirectory: '/repo',
        language: 'zh' as const,
        setLanguage: vi.fn(),
        cloudUIStrings: undefined,
      };
      return {
        useAppStore: Object.assign((selector?: (value: typeof state) => unknown) =>
          selector? selector(state):state,{ getState: () => state }),
      };
    });
    vi.doMock('../../../src/renderer/stores/sessionStore',() => ({
      useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) =>
        selector({ currentSessionId: 'session-1' }),
    }));
    ToolCallDisplay=(await import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay')).ToolCallDisplay;
    TraceNodeRenderer=(await import('../../../src/renderer/components/features/chat/TraceNodeRenderer')).TraceNodeRenderer;
  });
  afterAll(() => {
    vi.doUnmock('../../../src/renderer/stores/appStore');
    vi.doUnmock('../../../src/renderer/stores/sessionStore');
    vi.resetModules();
  });


  // 注册表真实形状（multiEditSchema）：file_path + edits[]（old_text/new_text）。
  const EDIT_ARGS={
    file_path: '/tmp/report.md',
    edits: [{ old_text: '旧段落',new_text: '新段落' }],
  };

  const EDIT_ERROR='File must be read before editing';


  function makeFailedEditToolCall(metadata?: Record<string,unknown>): ToolCall {
    return {
      id: 'edit-failed',
      name: 'Edit',
      arguments: EDIT_ARGS,
      result: { toolCallId: 'edit-failed',success: false,error: EDIT_ERROR,metadata },
    };
  }


  function makeEditNode(recovered: boolean,legacy=false): TraceNode {
    return {
      id: 'n-edit-failed',
      messageId: 'm1',
      type: 'tool_call',
      content: '',
      timestamp: 100,
      toolCall: {
        id: 'edit-failed',
        name: legacy? 'edit_file':'Edit',
        args: legacy
          ? { file_path: '/tmp/report.md',old_string: '旧段落',new_string: '新段落' }
          :EDIT_ARGS,
        result: EDIT_ERROR,
        success: false,
        recovered,
      },
    };
  }


  afterEach(() => {
    cleanup();
  });


  describe('ToolCallDisplay · recovered Edit row',() => {
    it('renders a quiet recovered footnote instead of the failed row once the retry succeeded',() => {
      const { container }=render(
        <ToolCallDisplay toolCall={makeFailedEditToolCall({ recovered: true })} index={0} total={1} />,
      );

      expect(container.textContent).not.toContain('未成功');
      expect(container.textContent).not.toContain('暂无失败原因摘要');
      const note=container.querySelector('[data-testid="tool-call-recovered-note"]');
      expect(note?.textContent).toBe('后续修改已成功');
    });

    it('keeps the failed headline and failure-reason line when the retry has not recovered it',() => {
      const { container }=render(
        <ToolCallDisplay toolCall={makeFailedEditToolCall()} index={0} total={1} />,
      );

      expect(container.textContent).toContain('未成功');
      expect(container.textContent).toContain('暂无失败原因摘要');
      expect(container.querySelector('[data-testid="tool-call-recovered-note"]')).toBeNull();
      expect(container.textContent).not.toContain('后续修改已成功');
    });
  });


  describe('TraceNodeRenderer · recovered Edit node wiring',() => {
    it('passes node.toolCall.recovered through to the rendered row (registered edits[] shape)',() => {
      const html=renderToStaticMarkup(
        React.createElement(TraceNodeRenderer,{ node: makeEditNode(true) }),
      );

      expect(html).not.toContain('未成功');
      expect(html).not.toContain('暂无失败原因摘要');
      expect(html).toContain('data-testid="tool-call-recovered-note"');
      expect(html).toContain('后续修改已成功');
    });

    it('still renders the failed row when the retry edited a different place',() => {
      const html=renderToStaticMarkup(
        React.createElement(TraceNodeRenderer,{ node: makeEditNode(false) }),
      );

      expect(html).toContain('未成功');
      expect(html).not.toContain('tool-call-recovered-note');
    });

    it('demotes legacy flat edit_file-shaped recovered rows the same way',() => {
      const html=renderToStaticMarkup(
        React.createElement(TraceNodeRenderer,{ node: makeEditNode(true,true) }),
      );

      expect(html).not.toContain('未成功');
      expect(html).toContain('data-testid="tool-call-recovered-note"');
      expect(html).toContain('后续修改已成功');
    });
  });
});

describe('toolHeader.terminalCopy',() => {
  let ToolCallDisplay: typeof import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay')['ToolCallDisplay'];
  let ToolHeader: typeof import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolHeader')['ToolHeader'];
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('../../../src/renderer/stores/appStore',() => {
      const state={
        processingSessionIds: new Set<string>(),
        pendingPermissionRequest: null as Record<string,unknown>|null,
        pendingPermissionSessionId: null as string|null,
        queuedPermissionRequests: [] as Array<Record<string,unknown>>,
        openPreview: vi.fn(),
        workingDirectory: '/repo',
        language: 'zh' as const,
        setLanguage: vi.fn(),
        cloudUIStrings: undefined,
      };
      return {
        __mockAppState: state,
        useAppStore: Object.assign((selector?: (value: typeof state) => unknown) => selector? selector(state):state,{ getState: () => state }),
      };
    });
    vi.doMock('../../../src/renderer/stores/sessionStore',() => ({
      useSessionStore: (selector: (value: { currentSessionId: string|null }) => unknown) => (
        selector({ currentSessionId: mockCurrentSessionId })
      ),
    }));
    ToolCallDisplay=(await import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay')).ToolCallDisplay;
    ToolHeader=(await import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolHeader')).ToolHeader;
  });
  afterAll(() => {
    vi.doUnmock('../../../src/renderer/stores/appStore');
    vi.doUnmock('../../../src/renderer/stores/sessionStore');
    vi.resetModules();
  });


  let mockCurrentSessionId: string|null='session-1';


  afterEach(cleanup);


  describe('ToolHeader terminal copy',() => {
    it('pending approval renders request phrasing instead of the completed write claim',() => {
      const toolCall: ToolCall={ id: 'write-pending',name: 'Write',arguments: { file_path: 'notes.md' } };
      const view=render(<ToolHeader toolCall={toolCall} status="pending" awaitingApproval />);
      expect(view.container.textContent).toContain('请求写入 notes.md');
      expect(view.container.textContent).not.toContain('写入了 notes.md');
    });

    it('被拒绝的腾讯会议创建行只显示一次终态与原因，并把动作写成意图式',() => {
      const toolCall: ToolCall={
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

      const view=render(<ToolCallDisplay toolCall={toolCall} index={0} total={1} />);
      // #1-story-A 2c44c0cf9 起：失败原因搬进折叠行下方独立的一行（组件整体的兄弟节点，
      // 不再挂在 tool-call-row-... 这个 testid 内部），且不再重复一个和原因近义的终态徽标词
      // （"未获批准"≈"审批被拒绝"，ToolStepGroup 的同款折叠 declutter 见旁边那条测试）。
      // 用整个容器读，才是用户真实看到的"这一行 + 紧跟的原因"。
      const text=view.container.textContent??'';

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
    it('a user-denied write reads the same in the expanded row as in the group head',() => {
      const toolCall: ToolCall={
        id: 'w',name: 'Write',arguments: { file_path: '/workspace/report.md' },
        result: {
          toolCallId: 'w',success: false,error: 'not approved',metadata: {
            failureCode: 'permission-denied',
            hostReason: { code: 'PERMISSION_DENIED_BY_USER',modelText: 'user denied' },
          }
        },
      };
      const view=render(<ToolCallDisplay toolCall={toolCall} index={0} total={1} />);
      const text=view.container.textContent??'';
      expect(text).not.toContain(zh.deliveryExperience.approvalRequired);
      expect(text).toContain(humanizeToolFailureReason(toolCall,zh));
    });

    it('foreground spawn_agent renders pending-approval / running wording while active and only shows 未成功 with real reason on failure',async () => {
      const appStoreMod=await import('../../../src/renderer/stores/appStore') as unknown as {
        __mockAppState: {
          processingSessionIds: Set<string>;
          pendingPermissionRequest: Record<string,unknown>|null;
          pendingPermissionSessionId: string|null;
        };
      };
      const sessionId='session-ca8c3df9';
      mockCurrentSessionId=sessionId;
      appStoreMod.__mockAppState.processingSessionIds=new Set([sessionId]);
      appStoreMod.__mockAppState.pendingPermissionSessionId=sessionId;
      appStoreMod.__mockAppState.pendingPermissionRequest={
        id: 'perm-1',
        sessionId,
        tool: 'Bash',
        parentToolUseId: 'call_33e127b9ca0a4c078fbad4c8',
      };

      const persistedRunningSpawnCall: ToolCall={
        id: 'call_33e127b9ca0a4c078fbad4c8',
        name: 'spawn_agent',
        arguments: {
          role: 'coder',
          task: '严格按以下两阶段执行，不得偏离：【阶段一 · 唯一一次工具调用】首先且仅调用一次 Bash 工具，命令为：printf "ok" > /tmp/neo-approve-test.txt',
        },
      };

      const approvalView=render(
        <ToolCallDisplay
          toolCall={persistedRunningSpawnCall}
          index={0}
          total={1}
          mediaContext={{ sessionId,messageId: '438997a6' }}
        />,
      );
      const approvalText=approvalView.container.textContent??'';
      expect(approvalText).toContain('请求启动代理');
      expect(approvalText).not.toContain('启动代理未成功');
      approvalView.unmount();

      // User clicks Allow: pendingPermissionRequest clears, child continues running
      appStoreMod.__mockAppState.pendingPermissionRequest=null;
      const runningView=render(
        <ToolCallDisplay
          toolCall={persistedRunningSpawnCall}
          index={0}
          total={1}
          mediaContext={{ sessionId,messageId: '438997a6' }}
        />,
      );
      const runningText=runningView.container.textContent??'';
      expect(runningText).toContain('正在启动代理');
      expect(runningText).not.toContain('启动代理未成功');
      expect(runningText).not.toContain('已中断');
      runningView.unmount();

      // Real failure (persisted call_5fa74e436eb64c64be688ce9) shows 未成功 and its mapped failure reason, not failureReasonMissing
      const persistedFailedSpawnCall: ToolCall={
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
      const failedView=render(
        <ToolCallDisplay
          toolCall={persistedFailedSpawnCall}
          index={0}
          total={1}
          mediaContext={{ sessionId,messageId: '69aeef46' }}
        />,
      );
      const failedText=failedView.container.textContent??'';
      expect(failedText).toContain('启动代理未成功');
      expect(failedText).toContain(zh.toolStepHumanize.failureCodes['tool-unavailable']);
      expect(failedText).not.toContain(zh.toolStepHumanize.failureReasonMissing);

      mockCurrentSessionId='session-1';
      appStoreMod.__mockAppState.processingSessionIds=new Set();
      appStoreMod.__mockAppState.pendingPermissionSessionId=null;
    });
  });
});

describe('toolStatusLine.contradict',() => {
  let ToolCallDisplay: typeof import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay')['ToolCallDisplay'];
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('../../../src/renderer/hooks/useI18n',async () => {
      const { zh }=await import('../../../src/renderer/i18n/zh');
      return { useI18n: () => ({ t: zh,language: 'zh' }) };
    });
    vi.doMock('../../../src/renderer/stores/appStore',() => ({
      useAppStore: Object.assign((selector?: (state: typeof appState) => unknown) => (
        selector? selector(appState):appState
      ),{ getState: () => appState }),
    }));
    vi.doMock('../../../src/renderer/stores/sessionStore',() => ({
      useSessionStore: (selector: (state: { currentSessionId: string|null }) => unknown) => (
        selector({ currentSessionId: 'session-1' })
      ),
    }));
    vi.doMock('../../../src/renderer/stores/backgroundTaskStore',() => ({
      useBackgroundTaskStore: (selector: (state: { tasks: never[] }) => unknown) => selector({ tasks: [] }),
    }));
    vi.doMock('../../../src/renderer/hooks/useAgentTreeSnapshot',() => ({
      useAgentTreeSnapshot: () => ({ snapshot: null }),
    }));
    vi.doMock('../../../src/renderer/utils/featureFlags',() => ({
      isSemanticToolUIEnabled: () => false,
    }));
    ToolCallDisplay=(await import('../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay')).ToolCallDisplay;
  });
  afterAll(() => {
    vi.doUnmock('../../../src/renderer/hooks/useI18n');
    vi.doUnmock('../../../src/renderer/stores/appStore');
    vi.doUnmock('../../../src/renderer/stores/sessionStore');
    vi.doUnmock('../../../src/renderer/stores/backgroundTaskStore');
    vi.doUnmock('../../../src/renderer/hooks/useAgentTreeSnapshot');
    vi.doUnmock('../../../src/renderer/utils/featureFlags');
    vi.resetModules();
  });


  const appState={
    processingSessionIds: new Set<string>(),
    pendingPermissionRequest: null,
    pendingPermissionSessionId: null,
    queuedPermissionRequests: {},
    openPreview: vi.fn(),
  };


  const CONTRADICTORY_TERMINALS=['已中断','未成功','未执行','应用重启时中断'] as const;


  function presentTerminals(text: string): string[] {
    return CONTRADICTORY_TERMINALS.filter((word) => text.includes(word));
  }


  afterEach(cleanup);


  describe('N-TOOLSTATUS-LINE-CONTRADICT rendering',() => {
    it('grep + 重启中断：状态行只有一个终态，不含 No matches',() => {
      const toolCall: ToolCall={
        id: 'grep-weather',
        name: 'Grep',
        arguments: { pattern: 'weather' },
        result: {
          toolCallId: 'grep-weather',
          success: true,
          output: 'No matches found',
        },
      };
      render(
        <ToolCallDisplay
          toolCall={toolCall}
          index={0}
          total={1}
          statusOverride="interrupted"
          interruptionReason="app-restart"
        />,
      );
      const text=screen.getByTestId('interrupt-timeline-step').textContent??'';
      expect(presentTerminals(text)).toEqual(['应用重启时中断']);
      expect(text).toContain('搜索 weather');
      expect(text).not.toMatch(/No matches/i);
      expect(text).not.toContain('执行时出了问题');
    });

    it('edit /dev/null + 重启中断：不含未成功和执行时出了问题',() => {
      const toolCall: ToolCall={
        id: 'edit-dev-null',
        name: 'Edit',
        arguments: { file_path: '/dev/null' },
        result: {
          toolCallId: 'edit-dev-null',
          success: false,
          error: 'ENOENT: no such file or directory',
        },
      };
      render(
        <ToolCallDisplay
          toolCall={toolCall}
          index={0}
          total={1}
          statusOverride="interrupted"
          interruptionReason="app-restart"
        />,
      );
      const text=screen.getByTestId('interrupt-timeline-step').textContent??'';
      expect(presentTerminals(text)).toEqual(['应用重启时中断']);
      expect(text).toContain('编辑 /dev/null');
      expect(text).not.toContain('未成功');
      expect(text).not.toContain('执行时出了问题');
    });
  });
});
