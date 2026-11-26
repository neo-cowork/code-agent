import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { AUXILIARY_RUN_SYSTEM_CONTEXT, resolveBackgroundRunTerminal } from '../../../src/host/task/backgroundRunOutcome';

const M = '__NEO_TASK_OUTCOME__';
const noTools: Message[] = [];

function terminal(finalText: string | undefined) {
  return resolveBackgroundRunTerminal({ messages: noTools, finalText, artifactCount: 0, workingDirectory: undefined, locale: 'zh' });
}

describe('background run marker parsing (via the terminal resolver)', () => {
  it('reads the first-line marker, strips it and records the trimmed reason', () => {
    const result = terminal(`${M}{"status":"failed","reason":" 源文件不存在 "}\n没复制。`);
    expect(result.type).toBe('task_error');
    expect(result.data).toMatchObject({ outcome: { status: 'failed', reason: '源文件不存在' }, rawDetail: '源文件不存在\n\n没复制。' });
  });
  it('no marker: text passes through untouched with no outcome (no guess)', () => {
    expect(terminal('I could not copy the file.')).toEqual({ type: 'task_completed', data: { conclusion: 'I could not copy the file.' } });
    expect(terminal(undefined)).toEqual({ type: 'task_completed', data: { conclusion: undefined } });
  });
  it('strips unparseable or unknown-status markers but invents no outcome', () => {
    expect(terminal(`${M}{oops\nbody`).data).toEqual({ conclusion: 'body' });
    expect(terminal(`${M}{"status":"great"}\nbody`).data).toEqual({ conclusion: 'body' });
  });
  it('strips a marker line that is not on the first line without trusting it', () => {
    expect(terminal(`intro\n${M}{"status":"failed"}\nbody`)).toEqual({ type: 'task_completed', data: { conclusion: 'intro\nbody' } });
  });
  it('the run context asks for the marker', () => {
    expect(AUXILIARY_RUN_SYSTEM_CONTEXT).toContain(M);
  });
});
