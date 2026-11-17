// N-FIX-SIMPLE-SUM-TWO-FAILED-BASH-ROWS-NOISE — 附件求和轮：模型发了本轮没开放的命令，
// host 封口成 TOOL_DISABLED_FOR_RUN + TOOL_BATCH_SKIPPED 两行；最终答案正确后这两行必须降级，
// 而真实的 Bash 失败（无 bounced 标记）仍保持失败。
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

function turn(opts: { bounced: boolean }): Message[] {
  const meta = (code: string) => (opts.bounced ? { skipped: true, bounced: true, code } : { exitCode: 1 });
  return [
    { id: 'u1', role: 'user', content: '把这些报销加起来告诉我总数', timestamp: 100 },
    {
      id: 'a1', role: 'assistant', content: '', timestamp: 150,
      toolCalls: [
        { id: 'tc-1', name: 'Bash', arguments: { command: 'cat *.txt' },
          result: { toolCallId: 'tc-1', success: false, error: 'x', duration: 0, metadata: meta('TOOL_DISABLED_FOR_RUN') } },
        { id: 'tc-2', name: 'Bash', arguments: { command: 'wc -l *.txt' },
          result: { toolCallId: 'tc-2', success: false, error: 'y', duration: 0, metadata: meta('TOOL_BATCH_SKIPPED') } },
      ],
      contentParts: [{ type: 'tool_call', toolCallId: 'tc-1' }, { type: 'tool_call', toolCallId: 'tc-2' }],
    },
    { id: 'a2', role: 'assistant', content: '合计 550 元。', timestamp: 250 },
  ];
}

function failedRows(messages: Message[]) {
  const turns = projectTurns(messages, 's', false, []).turns;
  return turns[turns.length - 1].nodes.filter((n) => n.toolCall && n.toolCall.success === false);
}

describe('系统关卡封口行在最终答案后降级', () => {
  it('bounced 的 Bash 行（拦下 + 同批跳过）都标 recovered', () => {
    const rows = failedRows(turn({ bounced: true }));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.toolCall?.recovered)).toEqual([true, true]);
  });

  it('修复步骤收窄的合成结果（narrowedBy + bounced）与执行器兜底闸同样降级', () => {
    const msgs = turn({ bounced: true });
    const results = msgs[1].toolCalls!.map((tc) => tc.result!);
    results[0].metadata = { skipped: false, bounced: true, narrowedBy: 'artifact_repair' };
    results[1].metadata = { code: 'TOOL_DISABLED_FOR_RUN', bounced: true };
    expect(failedRows(msgs).map((r) => r.toolCall?.recovered)).toEqual([true, true]);
  });

  it('真实 Bash 失败（无 bounced）不降级', () => {
    const rows = failedRows(turn({ bounced: false }));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.toolCall?.recovered)).toEqual([undefined, undefined]);
  });

  it('没有最终答案时 bounced 行仍保持失败', () => {
    const rows = failedRows(turn({ bounced: true }).slice(0, 2));
    expect(rows.map((r) => r.toolCall?.recovered)).toEqual([undefined, undefined]);
  });
});
