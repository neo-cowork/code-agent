// N-FIX-DISPATCH-STEP-REJECTED-IN-REPORT-ROUND-SHOWS-RECOVERED — 汇报轮被关卡拒绝的派发/委托步骤
// （delegate_task / spawn_agent / delegate_session，metadata.bounced === true）从未执行，
// 后续助手正文或其它成功工具不能将它标成 recovered，终端态必须落入 notRun。
import { describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import {
  resolveToolCallTerminalState,
  traceTerminalToolCall,
} from '../../../src/renderer/utils/toolCallTerminalState';

const V62_BOUNCED_META = {
  skipped: true,
  bounced: true,
  code: 'TOOL_DISABLED_FOR_RUN',
} as const;

function buildSingleStepThenReply(toolCall: ToolCall, reply = '风格已记下（corporate），但整套 8 页还没开始合成，这一步没执行。'): Message[] {
  return [
    { id: 'u-1', role: 'user', content: 'corporate', timestamp: 100 },
    {
      id: 'a-1',
      role: 'assistant',
      content: '已选定 corporate 风格，我现在开始合成整套 8 页。',
      timestamp: 150,
      toolCalls: [toolCall],
      contentParts: [
        { type: 'text', text: '已选定 corporate 风格，我现在开始合成整套 8 页。' },
        { type: 'tool_call', toolCallId: toolCall.id },
      ],
    },
    {
      id: 'a-2',
      role: 'assistant',
      content: reply,
      timestamp: 250,
      contentParts: [{ type: 'text', text: reply }],
    },
  ];
}

function projectToolNodes(messages: Message[]) {
  const turns = projectTurns(messages, 'web-session-v6-2', false, []).turns;
  return turns[turns.length - 1].nodes.filter((n) => n.type === 'tool_call' && n.toolCall);
}

describe('bounced delegation steps in report round are never recovered by later text or successes', () => {
  it('v6-2 delegate_task with {skipped:true,bounced:true,code:TOOL_DISABLED_FOR_RUN} + assistant text stays unrecovered and resolves notRun', () => {
    const messages = buildSingleStepThenReply({
      id: 'call_9d8d781e69db42f5902667db',
      name: 'delegate_task',
      shortDescription: 'Use delegate_task',
      arguments: {
        lane_key: 'q3-ppt-merge',
        short_name: '合成',
        submission_key: 'q3-ppt-merge-1',
        title: '按 corporate 风格合成 8 页季度汇报 PPT',
        prompt: '按 corporate 风格合成整套 8 页 PPT。',
      },
      result: {
        toolCallId: 'call_9d8d781e69db42f5902667db',
        success: false,
        error: 'denied by report-round tool policy',
        userMessage: '命令没有运行，相关内容没有改动。我可以先帮你查看要处理的内容，或交给后台任务，操作前会先问你。',
        duration: 0,
        metadata: { ...V62_BOUNCED_META },
      },
    });

    const nodes = projectToolNodes(messages);
    expect(nodes).toHaveLength(1);
    const tc = nodes[0].toolCall!;
    expect(tc.recovered).toBeUndefined();

    const terminal = resolveToolCallTerminalState({ toolCall: traceTerminalToolCall(tc) });
    expect(terminal).toMatchObject({
      state: 'failed',
      displayStatus: 'error',
      stepStatus: 'failed',
      notRun: true,
      skipped: false,
      handedOff: false,
    });
  });

  it.each([
    { name: 'spawn_agent', args: { role: 'coder', description: '生成汇总表' }, code: 'TOOL_DISABLED_FOR_RUN' },
    { name: 'delegate_session', args: { action: 'create_new', prompt: '继续整理' }, code: 'TOOL_BATCH_SKIPPED' },
  ] as const)('bounced $name stays unrecovered even when followed by a successful Read and final text', ({ name, args, code }) => {
    const messages: Message[] = [
      { id: 'u-1', role: 'user', content: '继续处理', timestamp: 100 },
      {
        id: 'a-1',
        role: 'assistant',
        content: '',
        timestamp: 150,
        toolCalls: [
          {
            id: 'tc-handoff',
            name,
            arguments: args,
            result: {
              toolCallId: 'tc-handoff',
              success: false,
              error: 'refused',
              duration: 0,
              metadata: { skipped: true, bounced: true, code },
            },
          },
          {
            id: 'tc-read',
            name: 'Read',
            arguments: { file_path: '/tmp/outline.md' },
            result: { toolCallId: 'tc-read', success: true, output: '# Outline', duration: 3 },
          },
        ],
        contentParts: [
          { type: 'tool_call', toolCallId: 'tc-handoff' },
          { type: 'tool_call', toolCallId: 'tc-read' },
        ],
      },
      { id: 'a-2', role: 'assistant', content: '我已读取大纲，派发步骤未执行。', timestamp: 250 },
    ];

    const nodes = projectToolNodes(messages);
    const handoffNode = nodes.find((n) => n.toolCall?.id === 'tc-handoff')!;
    expect(handoffNode.toolCall?.recovered).toBeUndefined();
    expect(resolveToolCallTerminalState({ toolCall: traceTerminalToolCall(handoffNode.toolCall!) }).notRun).toBe(true);
  });

  it('does not mark notRun when metadata.executed === true or when handed off to background', () => {
    const executed = resolveToolCallTerminalState({
      toolCall: {
        id: 'tc-exec',
        name: 'delegate_task',
        arguments: { title: '合成 PPT' },
        result: {
          toolCallId: 'tc-exec',
          success: false,
          error: 'failed after running',
          metadata: { bounced: true, executed: true },
        },
      },
    });
    expect(executed.notRun).toBe(false);

    const handedOff = resolveToolCallTerminalState({
      toolCall: {
        id: 'tc-ho',
        name: 'delegate_task',
        arguments: { title: '合成 PPT' },
        result: {
          toolCallId: 'tc-ho',
          success: false,
          error: 'handed off',
          metadata: { skipped: true, bounced: true, code: 'HANDED_OFF_TO_BACKGROUND' },
        },
      },
    });
    expect(handedOff.handedOff).toBe(true);
    expect(handedOff.notRun).toBe(false);
  });

  it('keeps bounced Bash and retried WebSearch / same-place Edit recovery intact', () => {
    const editArgs = {
      file_path: '/tmp/outline.md',
      edits: [{ old_text: '草稿', new_text: '定稿' }],
    };
    const messages: Message[] = [
      { id: 'u-1', role: 'user', content: '更新大纲并查资料', timestamp: 100 },
      {
        id: 'a-1',
        role: 'assistant',
        content: '',
        timestamp: 150,
        toolCalls: [
          {
            id: 'tc-bash',
            name: 'Bash',
            arguments: { command: 'wc -l outline.md' },
            result: {
              toolCallId: 'tc-bash',
              success: false,
              error: 'disabled',
              metadata: { ...V62_BOUNCED_META },
            },
          },
          {
            id: 'tc-search-fail',
            name: 'WebSearch',
            arguments: { query: '季度汇报模板' },
            result: { toolCallId: 'tc-search-fail', success: false, error: 'timeout' },
          },
          {
            id: 'tc-search-ok',
            name: 'WebSearch',
            arguments: { query: '季度汇报结构' },
            result: { toolCallId: 'tc-search-ok', success: true, output: 'results' },
          },
          {
            id: 'tc-edit-fail',
            name: 'Edit',
            arguments: editArgs,
            result: { toolCallId: 'tc-edit-fail', success: false, error: 'File must be read before editing' },
          },
          {
            id: 'tc-edit-ok',
            name: 'Edit',
            arguments: editArgs,
            result: { toolCallId: 'tc-edit-ok', success: true, output: 'updated' },
          },
        ],
      },
      { id: 'a-2', role: 'assistant', content: '已完成更新。', timestamp: 250 },
    ];

    const byId = new Map(projectToolNodes(messages).map((n) => [n.toolCall!.id, n.toolCall!]));
    expect(byId.get('tc-bash')?.recovered).toBe(true);
    expect(byId.get('tc-search-fail')?.recovered).toBe(true);
    expect(byId.get('tc-edit-fail')?.recovered).toBe(true);
  });
});
