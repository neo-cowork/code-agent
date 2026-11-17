import { describe, expect, it } from 'vitest';
import type { TraceProjection } from '../../../src/shared/contract/trace';
import { buildRunUiState } from '../../../src/renderer/utils/runWorkbenchProjection';
import {
  countToolSteps,
  resolveBackgroundTerminalKey,
  resolveRunTerminalKey,
} from '../../../src/renderer/utils/terminalWord';

type Step = { name: string; arguments: Record<string, unknown>; success: boolean; pending?: boolean; streaming?: boolean };
const read = (path: string, success: boolean): Step => ({ name: 'Read', arguments: { file_path: path }, success });
const bash = (command: string, success: boolean): Step => ({ name: 'Bash', arguments: { command }, success });

const cases: { name: string; steps: Step[]; outcome: string; failed: number }[] = [
  { name: 'recovered same-tool retry on a.pdf', steps: [read('a.pdf', false), read('a.pdf', true)], outcome: 'completed', failed: 0 },
  { name: 'recovered different-tool Bash then Read on a.pdf', steps: [bash('pdftotext a.pdf -', false), read('a.pdf', true)], outcome: 'completed', failed: 0 },
  { name: 'unresolved failure with no later matching success', steps: [read('a.pdf', false), { name: 'List', arguments: {}, success: true }], outcome: 'completed-with-warnings', failed: 1 },
  { name: 'every finished step failed', steps: [read('a.pdf', false), read('b.pdf', false)], outcome: 'failed-tool', failed: 2 },
  { name: 'failure on a.pdf and success only on b.pdf still warns', steps: [read('a.pdf', false), read('b.pdf', true)], outcome: 'completed-with-warnings', failed: 1 },
  { name: 'earlier success cannot recover a later failure', steps: [read('a.pdf', true), read('a.pdf', false)], outcome: 'completed-with-warnings', failed: 1 },
  { name: 'one of three PDFs remains unread', steps: [read('a.pdf', false), read('b.pdf', false), read('c.pdf', true), read('a.pdf', true)], outcome: 'completed-with-warnings', failed: 1 },
  { name: 'recovered quoted command path with spaces and normalized basename', steps: [bash('pdftotext "./contracts/旧版/../合同 A.pdf" -', false), read('/workspace/contracts/合同 A.pdf', true)], outcome: 'completed', failed: 0 },
  { name: 'recovered filename inside a quoted Bash script', steps: [bash(`python -c "open('a.pdf').read()"`, false), read('a.pdf', true)], outcome: 'completed', failed: 0 },
  { name: 'recovered command option target', steps: [bash('convert --input="a.pdf"', false), read('a.pdf', true)], outcome: 'completed', failed: 0 },
  { name: 'recovered Windows path and camel-case argument', steps: [{ name: 'Read', arguments: { filePath: 'C:\\contracts\\a.pdf' }, success: false }, read('a.pdf', true)], outcome: 'completed', failed: 0 },
  { name: 'recovered overlapping target arrays', steps: [{ name: 'Read', arguments: { path: ['a.pdf', 'b.pdf'] }, success: false }, read('b.pdf', true)], outcome: 'completed', failed: 0 },
  { name: 'recovered URL across tools', steps: [{ name: 'Fetch', arguments: { url: 'https://example.test/contracts/a.pdf' }, success: false }, { name: 'Download', arguments: { url: 'https://example.test/contracts/a.pdf' }, success: true }], outcome: 'completed', failed: 0 },
  { name: 'recovered pattern target', steps: [{ name: 'Search', arguments: { pattern: 'a.pdf' }, success: false }, read('a.pdf', true)], outcome: 'completed', failed: 0 },
  { name: 'recovered same tool with no targets', steps: [{ name: 'List', arguments: {}, success: false }, { name: 'List', arguments: {}, success: true }], outcome: 'completed', failed: 0 },
  { name: 'different untargeted tools do not recover', steps: [{ name: 'List', arguments: {}, success: false }, { name: 'Search', arguments: {}, success: true }], outcome: 'completed-with-warnings', failed: 1 },
  { name: 'targeted success cannot recover untargeted failure', steps: [{ name: 'Read', arguments: {}, success: false }, read('a.pdf', true)], outcome: 'completed-with-warnings', failed: 1 },
  { name: 'pending success cannot recover a failure', steps: [read('a.pdf', false), { ...read('a.pdf', true), pending: true }], outcome: 'failed-tool', failed: 1 },
  { name: 'streaming success cannot recover a failure', steps: [read('a.pdf', false), { ...read('a.pdf', true), streaming: true }], outcome: 'failed-tool', failed: 1 },
  { name: 'cd directory shared by two commands does not recover a different file', steps: [bash('cd "/ws/合同" && pdftotext 合同A.pdf -', false), bash('cd "/ws/合同" && pdftotext 合同B.pdf -', true)], outcome: 'completed-with-warnings', failed: 1 },
  { name: '/dev/null redirection sink does not link commands', steps: [bash('pdftotext /ws/合同A.pdf - 2>/dev/null', false), bash('ls /ws/x 2>/dev/null', true)], outcome: 'completed-with-warnings', failed: 1 },
  { name: 'cd command failure recovered by Read of the same file', steps: [bash('cd "/ws/合同" && pdftotext 合同A.pdf -', false), read('/ws/合同/合同A.pdf', true)], outcome: 'completed', failed: 0 },
  { name: 'failed npm test is not recovered by an unrelated later Bash command', steps: [bash('npm test', false), bash('git status', true)], outcome: 'completed-with-warnings', failed: 1 },
  { name: 'failed npm test is recovered by the identical command rerun', steps: [bash('npm test', false), bash('npm test', true)], outcome: 'completed', failed: 0 },
  { name: 'same file name in different directories does not recover', steps: [{ name: 'Edit', arguments: { file_path: 'src/a/index.ts' }, success: false }, { name: 'Edit', arguments: { file_path: 'src/b/index.ts' }, success: true }], outcome: 'completed-with-warnings', failed: 1 },
  { name: 'relative path recovered by absolute path of the same file', steps: [read('src/a/index.ts', false), read('/ws/src/a/index.ts', true)], outcome: 'completed', failed: 0 },
  { name: 'differently spelled typo stays unresolved', steps: [read('aa.pdf', false), read('a.pdf', true)], outcome: 'completed-with-warnings', failed: 1 },
];

function project(steps: Step[]) {
  const projection: TraceProjection = {
    sessionId: 'contracts', activeTurnIndex: 0,
    turns: [{
      turnId: 'contracts-turn', turnNumber: 1, startTime: 100, status: 'completed',
      nodes: steps.map((step, index) => ({
        id: `node-${index}`, type: 'tool_call', content: '', timestamp: 100 + index,
        toolCall: {
          id: `call-${index}`, name: step.name, args: step.arguments, success: step.success,
          result: step.pending ? undefined : 'finished', _streaming: step.streaming,
        },
      })),
    }],
  };
  return buildRunUiState({ projection, sessionId: 'contracts', sessionStatus: 'idle' });
}

for (const source of ['foreground projection', 'background stored results', 'background merged results'] as const) {
  describe(source, () => {
    it.each(cases)('$name', ({ steps, outcome, failed }) => {
      const finished = steps.filter((step) => !step.pending && !step.streaming).length;
      if (source === 'foreground projection') {
        const run = project(steps);
        expect(run.toolStepOutcome).toEqual({ failed, total: finished });
        // A streaming/pending call keeps a foreground run live; the completed word is asserted only after it finishes.
        expect(resolveRunTerminalKey(run)).toBe(steps.some((step) => step.pending || step.streaming) ? null : outcome);
      } else {
        const toolCalls = steps.map((step, index) => ({
          id: `call-${index}`, name: step.name, arguments: step.arguments, _streaming: step.streaming,
          ...(source === 'background merged results' && !step.pending ? { result: { success: step.success } } : {}),
        }));
        const toolResults = steps.flatMap((step, index) => step.pending ? [] : [{ toolCallId: `call-${index}`, success: step.success }]);
        const result = countToolSteps([{ toolCalls }, { toolResults }]);
        expect(result).toEqual({ failed, total: finished });
        expect(resolveBackgroundTerminalKey({ status: 'completed' }, { toolStepOutcome: result })).toBe(outcome);
        expect(resolveRunTerminalKey({ status: 'completed', toolStepOutcome: result })).toBe(outcome);
      }
    });
  });
}

it('background result arrival order cannot turn an earlier success into a later retry', () => {
  const result = countToolSteps([
    { toolCalls: [
      { id: 'first', name: 'Read', arguments: { path: 'a.pdf' } },
      { id: 'second', name: 'Read', arguments: { path: 'a.pdf' } },
    ] },
    { toolResults: [{ toolCallId: 'second', success: false }, { toolCallId: 'first', success: true }] },
  ]);
  expect(resolveBackgroundTerminalKey({ status: 'completed' }, { toolStepOutcome: result })).toBe('completed-with-warnings');
});

describe('failed foreground read recovered by a background delegate_task', () => {
  type LedgerTask = NonNullable<Parameters<typeof buildRunUiState>[0]['backgroundTasks']>[number];
  const delegate = (prompt: string, id = 'deleg-1') => ({ id, name: 'delegate_task', arguments: { title: 'read', prompt }, success: true });
  const task = (over: Partial<LedgerTask> = {}): LedgerTask => ({ toolCallId: 'deleg-1', status: 'completed', ...over });
  const run = (calls: Array<{ id?: string; name: string; arguments: Record<string, unknown>; success: boolean }>, tasks: LedgerTask[]) => {
    const projection: TraceProjection = {
      sessionId: 's', activeTurnIndex: 0,
      turns: [{
        turnId: 't', turnNumber: 1, startTime: 1, status: 'completed',
        nodes: calls.map((call, index) => ({
          id: `n-${index}`, type: 'tool_call', content: '', timestamp: 1 + index,
          toolCall: { id: call.id ?? `c-${index}`, name: call.name, args: call.arguments, success: call.success, result: 'done' },
        })),
      }],
    };
    return resolveRunTerminalKey(buildRunUiState({ projection, sessionId: 's', sessionStatus: 'idle', backgroundTasks: tasks }));
  };
  const failedRead = { ...read('a.pdf', false) };

  it('completed delegation naming the failed file recovers the step', () => {
    expect(run([failedRead, delegate('请读取 /ws/contracts/a.pdf 并总结')], [task()])).toBe('completed');
    expect(run([failedRead, delegate('Read a.pdf and summarize it')], [task()])).toBe('completed');
  });

  it.each(['running', 'queued', 'failed', 'cancelled'])('%s delegation keeps the warning', (status) => {
    expect(run([failedRead, delegate('Read a.pdf')], [task({ status: status as LedgerTask['status'] })])).toBe('completed-with-warnings');
  });

  it('prompt that does not name the file keeps the warning', () => {
    expect(run([failedRead, delegate('Summarize the contracts')], [task()])).toBe('completed-with-warnings');
    expect(run([failedRead, delegate('Read data.pdf')], [task()])).toBe('completed-with-warnings');
    expect(run([read('src/a/x.ts', false), delegate('Read src/b/x.ts')], [task()])).toBe('completed-with-warnings');
  });

  it('two failed files with only one named keeps the warning', () => {
    expect(run([failedRead, read('b.pdf', false), delegate('Read a.pdf')], [task()])).toBe('completed-with-warnings');
    expect(run([failedRead, read('b.pdf', false), delegate('Read a.pdf and b.pdf')], [task()])).toBe('completed');
  });

  it('completed task with lastToolFailure keeps the warning', () => {
    expect(run([failedRead, delegate('Read a.pdf')], [task({ progress: { lastToolFailure: { toolName: 'Read' } } })])).toBe('completed-with-warnings');
  });

  it('task bound to a different tool call keeps the warning', () => {
    expect(run([failedRead, delegate('Read a.pdf')], [task({ toolCallId: 'other' })])).toBe('completed-with-warnings');
  });

  it('a delegation that came before the failure recovers nothing', () => {
    expect(run([delegate('Read a.pdf'), failedRead], [task()])).toBe('completed-with-warnings');
  });
});
