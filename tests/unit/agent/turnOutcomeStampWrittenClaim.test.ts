import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CompletionSummaryRecord, Message } from '../../../src/shared/contract';
import { TurnTraceRecorder } from '../../../src/host/agent/runtime/turnTrace';
import { recordTurnOutcomeStamp } from '../../../src/host/agent/runtime/turnOutcomeStamp';

const root = path.join(os.tmpdir(), `stamp-written-claim-${process.pid}-${Date.now()}`);

afterEach(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

const summary = (): CompletionSummaryRecord => ({
  schemaVersion: 1, id: 'c1', sessionId: 's1', objective: '周报', status: 'completed',
  startedAt: 1_700_000_000_000, endedAt: 1_700_000_000_100, durationMs: 100, iterations: 1,
  tokenUsage: { input: 1, output: 1, total: 2 }, toolCallCount: 1, changedFiles: [], commands: [],
  verificationEvidence: [], commitIds: [], risks: [], blockers: [], artifactRefs: [],
});

function messages(): Message[] {
  return [
    { id: 'u', role: 'user', content: '做一份周报，保存成文件', timestamp: 1_700_000_000_000 },
    {
      id: 'a', role: 'assistant', content: '', timestamp: 1_700_000_000_050,
      toolCalls: [{ id: 'w', name: 'Write', arguments: { file_path: 'report.md' } }],
      toolResults: [{ toolCallId: 'w', success: true, output: 'ok', metadata: { outputPath: 'report.md' } }],
    },
    { id: 'f', role: 'assistant', content: '已整理完毕', timestamp: 1_700_000_000_090 },
  ];
}

async function stamp(fileContent: string) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'report.md'), fileContent);
  const recorder = new TurnTraceRecorder('written-claim', root);
  await recordTurnOutcomeStamp(
    { sessionId: 's1', messages: messages(), turnTrace: recorder, workingDirectory: root },
    'completed',
    summary(),
  );
  const event = recorder.getEvents().filter((e) => e.type === 'turn_outcome').at(-1);
  if (!event || event.type !== 'turn_outcome') throw new Error('no turn_outcome');
  return event.data;
}

describe('turn outcome stamp with written claims', () => {
  it('flags DELIVERABLE_PLACEHOLDER_CONTENT for a written file without any claim wording', async () => {
    const outcome = await stamp('下周计划：待补充\n');
    expect((outcome.evidenceProblems ?? []).some((p) => p.startsWith('DELIVERABLE_PLACEHOLDER_CONTENT'))).toBe(true);
    expect(outcome.verdict).toBe('self_claimed');
  });

  it('a clean written file does not lift the verdict to verified (written is not a stated claim)', async () => {
    const outcome = await stamp('本周完成三项工作\n');
    expect(outcome.evidenceProblems).toEqual([]);
    expect(outcome.verdict).toBe('self_claimed');
  });
});
