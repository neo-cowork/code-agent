import { describe, expect, it } from 'vitest';
import { resolveStoppedTaskOutcome } from '../../../../src/host/services/commandCenter/sessionTaskStopConclusion';

const CLOSED = '<tool_call><function=Browser><parameter=action>type</parameter><parameter=targetRef>tref_snapshot_example_23</parameter><parameter=text>Tauri</parameter></function></tool_call>';
const UNCLOSED = '<tool_call><function=Browser><parameter=action>type</parameter><parameter=text>Tauri';
const PAGE = '「Example Domain」';

describe('resolveStoppedTaskOutcome markup-only browser conclusion', () => {
  it.each([
    ['closed tool_call', CLOSED],
    ['unclosed tool_call', UNCLOSED],
  ])('%s is unfinished and names the last page', (_label, detail) => {
    const outcome = resolveStoppedTaskOutcome({ status: 'completed', detail, lastUrl: PAGE });
    expect(outcome).toMatchObject({ status: 'failed', kind: 'no_conclusion' });
    expect(outcome.notice).toBe(outcome.detail);
    expect(outcome.detail).toContain('没有留下最终结果');
    expect(outcome.detail).toContain('继续');
    expect(outcome.detail).toContain(`最后停留在页面${PAGE}`);
    expect(outcome.detail).not.toMatch(/tool_call|function=|targetRef/);
  });

  it('keeps prose around a tool_call as a completed conclusion', () => {
    const outcome = resolveStoppedTaskOutcome({
      status: 'completed',
      detail: `页面标题是 Example Domain。\n${CLOSED}`,
      lastUrl: PAGE,
    });
    expect(outcome).toEqual({ status: 'completed', detail: '页面标题是 Example Domain。' });
  });

  it('leaves an ordinary conclusion completed', () => {
    expect(resolveStoppedTaskOutcome({
      status: 'completed',
      detail: '  页面标题是 Example Domain。  ',
    })).toEqual({ status: 'completed', detail: '页面标题是 Example Domain。' });
  });

  it('does not append markup-only leftovers onto a step-cap sentence', () => {
    const outcome = resolveStoppedTaskOutcome({
      status: 'completed',
      detail: CLOSED,
      lastUrl: PAGE,
      stepCap: { max: 8 },
    });
    expect(outcome.kind).toBe('step_cap');
    expect(outcome.status).toBe('failed');
    expect(outcome.detail).toContain('第 8 步（上限 8 步）');
    expect(outcome.detail).toContain(`最后停留在页面${PAGE}`);
    expect(outcome.detail).not.toMatch(/tool_call|function=/);
    expect(outcome.notice).toBe(outcome.detail);
  });
});
