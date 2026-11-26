// @vitest-environment jsdom
// N-FIX-TURN-HEADER-SKIPPED-BASH-SAYS-RAN：主机封存、从未执行的 Bash（metadata.skipped）不得被说成「运行了」。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceNode } from '../../../src/shared/contract/trace';
import { PARKED_APPROVAL_CLOSURE_SENTENCES } from '../../../src/shared/parkedApprovalClosure';
import { ToolStepGroup } from '../../../src/renderer/components/features/chat/ToolStepGroup';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { humanizeToolGroupLabel, humanizeToolStep } from '../../../src/renderer/utils/humanizeToolStep';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const SKIPPED_META = { skipped: true, bounced: true, code: 'TOOL_DISABLED_FOR_RUN' };

function bash(id: string, over: Partial<NonNullable<TraceNode['toolCall']>> = {}): TraceNode {
  return {
    id: `n-${id}`, type: 'tool_call', content: '', timestamp: 1,
    toolCall: { id, name: 'Bash', args: { command: 'ls' }, success: true, result: 'ok', ...over },
  } as TraceNode;
}
const skipped = (id: string, over: Partial<NonNullable<TraceNode['toolCall']>> = {}) =>
  bash(id, { success: false, result: 'skipped', metadata: SKIPPED_META, recovered: true, ...over });
const read = (id: string): TraceNode => ({
  id: `n-${id}`, type: 'tool_call', content: '', timestamp: 1,
  toolCall: { id, name: 'Read', args: { file_path: 'a.md' }, success: true, result: 'x' },
} as TraceNode);

function header(nodes: TraceNode[]): string {
  render(<ToolStepGroup nodes={nodes} sessionId="s1" />);
  return (screen.getByTestId('tool-group-head-label').textContent ?? '').trim();
}

describe.each(['zh', 'en'] as const)('skipped Bash in ToolStepGroup header (%s)', (lang) => {
  beforeEach(() => useAppStore.setState({ language: lang }));
  afterEach(cleanup);
  const zhEn = <T,>(a: T, b: T) => (lang === 'zh' ? a : b);

  it('all-skipped (degraded to recovered) group never says ran', () => {
    expect(header([skipped('a'), skipped('b')])).toBe(zhEn('有 2 条命令没有执行', '2 commands did not run'));
  });
  it('single skipped row (degraded to recovered): not-run sentence, with and without description', () => {
    expect(header([skipped('a')])).toBe(zhEn('有一条命令没有执行', 'A command did not run'));
    cleanup();
    // FB-2822 supersedes #3681's description rendering for skipped Bash.
    expect(header([skipped('a', { args: { command: 'ls', description: zhEn('列出目录', 'List the directory') } })]))
      .toBe(zhEn('有一条命令没有执行', 'A command did not run'));
  });
  it.each([
    ['same-language', zhEn('确认两份交付物存在且页数正确', 'Confirm both output files exist')],
    ['wrong-language', zhEn('Confirm both output files exist', '确认两份交付物存在且页数正确')],
    ['command-like', zhEn('检查 /tmp/deck.pptx', 'Check /tmp/deck.pptx')],
  ])('single skipped row uses the neutral sentence with a %s description', (_kind, description) => {
    expect(header([skipped('a', { args: { command: 'ls', description } })]))
      .toBe(zhEn('有一条命令没有执行', 'A command did not run'));
  });
  it('a Bash command that ran and failed still shows the failure and description', () => {
    const args = { command: 'ls', description: zhEn('列出目录', 'List the directory') };
    expect(header([bash('a', { args, success: false, result: 'exit status 1' })]))
      .toBe(zhEn('运行命令未成功 · 列出目录', 'Could not run a command · List the directory'));
  });
  it('a voided parked-approval Bash still shows the not-run prefix and requested action', () => {
    const args = { command: 'ls', description: zhEn('列出目录', 'List the directory') };
    const result = PARKED_APPROVAL_CLOSURE_SENTENCES.expiredAfterRestart24h;
    expect(header([bash('a', { args, success: false, result })]))
      .toBe(zhEn('未执行 · 请求运行命令 · 列出目录', 'Not run · Request to run a command · List the directory'));
  });
  it('mixed: 2 ran + 1 skipped counted separately', () => {
    expect(header([bash('a'), bash('b'), skipped('c')])).toBe(zhEn('运行了 2 条命令；1 条未执行', 'Ran 2 commands; 1 not run'));
  });
  it('un-degraded skipped (not recovered) also excluded from ran', () => {
    expect(header([read('r'), skipped('a', { recovered: false })])).not.toMatch(/运行了|Ran/);
  });
  it('Bash that really ran and was then replaced by the read-loop seal (executed:true) still says ran', () => {
    const sealed = (id: string) => skipped(id, { metadata: { ...SKIPPED_META, executed: true, readLoopSeal: true } });
    expect(header([sealed('a'), sealed('b')])).toBe(zhEn('运行了 2 条命令', 'Ran 2 commands'));
  });
  it('normal non-skipped Bash group still says ran', () => {
    expect(header([bash('a'), bash('b')])).toBe(zhEn('运行了 2 条命令', 'Ran 2 commands'));
  });
});

describe('skipped Bash single row (humanizeToolStep)', () => {
  it.each([[zh, '有一条命令没有执行'], [en, 'A command did not run']] as const)(
    'with / without description', (t, neutral) => {
      const desc = t === zh ? '列出目录' : 'List the directory';
      const ctx = { skipped: true };
      expect(humanizeToolStep('Bash', { command: 'ls', description: desc }, t, undefined, 'completed', undefined, ctx)).toBe(neutral);
      expect(humanizeToolStep('Bash', { command: 'ls' }, t, undefined, 'completed', undefined, ctx)).toBe(neutral);
      expect(humanizeToolStep('Bash', { command: 'ls' }, t)).toMatch(/运行了|Ran/);
    });
});

describe('humanizeToolGroupLabel skipped count', () => {
  it('count 1 / 2, zh and en', () => {
    expect(humanizeToolGroupLabel([], zh, 'completed', false, 1)).toBe('有一条命令没有执行');
    expect(humanizeToolGroupLabel([], zh, 'completed', false, 2)).toBe('有 2 条命令没有执行');
    expect(humanizeToolGroupLabel([], en, 'completed', false, 1)).toBe('A command did not run');
    expect(humanizeToolGroupLabel([], en, 'completed', false, 2)).toBe('2 commands did not run');
    expect(humanizeToolGroupLabel(['Bash', 'Bash'], zh, 'completed', false, 1)).toBe('运行了 2 条命令；1 条未执行');
  });
});
