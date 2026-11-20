import { describe, expect, it } from 'vitest';
import { AgentFailureCode, HostReasonCode, type ToolCall } from '@shared/contract';
import { isToolResultNeverExecuted } from '@shared/toolNeverExecuted';
import { resolveToolCallTerminalState } from '../../../src/renderer/utils/toolCallTerminalState';
import { humanizeToolStep } from '../../../src/renderer/utils/humanizeToolStep';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const failed = (metadata: Record<string, unknown>) => ({ success: false, metadata });

describe('isToolResultNeverExecuted', () => {
  it.each([
    ['skipped', { skipped: true }],
    ['bounced (run policy, no skipped flag)', { code: 'TOOL_DISABLED_FOR_RUN', bounced: true }],
    ['approval denied', { failureCode: AgentFailureCode.PermissionDenied, hostReason: { code: HostReasonCode.PermissionDeniedByUser } }],
    ['no approval UI', { hostReason: { code: HostReasonCode.PermissionDeniedNoApprovalUi } }],
  ])('is true for %s', (_name, metadata) => {
    expect(isToolResultNeverExecuted(failed(metadata))).toBe(true);
  });

  it('is false for a command that ran and exited non-zero, or that succeeded', () => {
    expect(isToolResultNeverExecuted(failed({ exitCode: 1 }))).toBe(false);
    expect(isToolResultNeverExecuted(failed({ skipped: true, bounced: true, executed: true }))).toBe(false);
    expect(isToolResultNeverExecuted({ success: true, metadata: { skipped: true } })).toBe(false);
    expect(isToolResultNeverExecuted(undefined)).toBe(false);
  });
});

describe('never-executed Bash presentation', () => {
  const bash = (metadata: Record<string, unknown>): ToolCall => ({
    id: 'b1', name: 'Bash', arguments: { command: 'ls ~/Downloads', description: 'List Downloads folder' },
    result: { toolCallId: 'b1', success: false, error: 'x', metadata },
  });

  it('terminal state marks a bounced Bash (no skipped flag) as skipped, but not a real failure', () => {
    expect(resolveToolCallTerminalState({ toolCall: bash({ code: 'TOOL_DISABLED_FOR_RUN', bounced: true }) }).skipped).toBe(true);
    expect(resolveToolCallTerminalState({ toolCall: bash({ failureCode: AgentFailureCode.PermissionDenied }) }).skipped).toBe(true);
    expect(resolveToolCallTerminalState({ toolCall: bash({ exitCode: 1, executed: true }) }).skipped).toBe(false);
    expect(resolveToolCallTerminalState({ toolCall: bash({ exitCode: 1 }) }).skipped).toBe(false);
  });

  it('reads "Not run · description" in both languages and never shows the command', () => {
    const call = bash({ bounced: true });
    const { skipped } = resolveToolCallTerminalState({ toolCall: call });
    for (const [t, description] of [[zh, '列出下载文件夹'], [en, 'List Downloads folder']] as const) {
      const args = { command: 'ls ~/Downloads', description };
      const label = humanizeToolStep('Bash', args, t, undefined, 'failed', undefined, { skipped });
      expect(label).toBe(`${t.toolStepHumanize.notRunPrefix} · ${description}`);
      expect(label).not.toContain('~/');
    }
    expect(en.toolStepHumanize.notRunPrefix).toBe('Not run');
  });
});

describe('describeLastToolStep (member current-action bar)', () => {
  it.each([[zh, '把 PDF 移进新文件夹'], [en, 'Move PDFs to Receipts']] as const)('reads "Not run · desc" when the step is notRun, plain otherwise', async (t, description) => {
    const { describeLastToolStep } = await import('../../../src/renderer/utils/agentActivity');
    const step = { tool: 'Bash', target: 'mkdir -p ~/Downloads/X && mv ~/Downloads/*.pdf ~/Downloads/X/', description, at: 1 };
    const steps = [{ description, command: step.target, notRun: true as const }];
    expect(describeLastToolStep(step, t, 'completed', steps)).toBe(`${t.toolStepHumanize.notRunPrefix} · ${description}`);
    expect(describeLastToolStep(step, t, 'completed', [{ description, command: step.target }])).not.toContain(t.toolStepHumanize.notRunPrefix);
    expect(describeLastToolStep(step, t, 'completed')).not.toContain(t.toolStepHumanize.notRunPrefix);
  });
});

describe('describeLastToolStep only trusts the LAST bash step (retry / prefix)', () => {
  it.each([[zh, '列出下载文件夹'], [en, 'List Downloads folder']] as const)('(a) denied then same command ran → plain', async (t, description) => {
    const { describeLastToolStep } = await import('../../../src/renderer/utils/agentActivity');
    const step = { tool: 'Bash', target: 'ls ~/Downloads', description, at: 1 };
    const steps = [{ description, command: 'ls ~/Downloads', notRun: true as const }, { description, command: 'ls ~/Downloads' }];
    expect(describeLastToolStep(step, t, 'completed', steps)).not.toContain(t.toolStepHumanize.notRunPrefix);
  });
  it.each([[zh, '列出目录'], [en, 'List the directory']] as const)('(b) denied `ls ~/secret` then ran `ls` → plain; (c) denied last step → Not run', async (t, description) => {
    const { describeLastToolStep } = await import('../../../src/renderer/utils/agentActivity');
    const denied = { description, command: 'ls ~/secret', notRun: true as const };
    expect(describeLastToolStep({ tool: 'Bash', target: 'ls', description, at: 1 }, t, 'completed', [denied, { description, command: 'ls' }]))
      .not.toContain(t.toolStepHumanize.notRunPrefix);
    expect(describeLastToolStep({ tool: 'Bash', target: 'ls ~/secret', description, at: 1 }, t, 'completed', [{ description, command: 'ls' }, denied]))
      .toBe(`${t.toolStepHumanize.notRunPrefix} · ${description}`);
  });
});
