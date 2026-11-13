import { describe, expect, it } from 'vitest';
import { AgentFailureCode } from '../../../src/shared/contract';
import { zh, en } from '../../../src/renderer/i18n';
import { humanizeToolStep } from '../../../src/renderer/utils/humanizeToolStep';
import { toolPreflightCopy } from '../../../src/renderer/utils/toolPreflightPresentation';

describe('cron naming residue regressions', () => {
  it('does not expose a command in Bash row text in either language or state', () => {
    for (const language of [zh, en]) for (const state of ['completed', 'pending-approval', 'running', 'failed'] as const) {
      const text = humanizeToolStep('Bash', { command: 'ls -la /tmp/example', description: 'ls -la /tmp/example' }, language, undefined, state);
      expect(text).not.toContain('ls -la');
      expect(text).not.toContain('/tmp/example');
    }
  });
  it('does not expose a blocked command in the preflight row', () => {
    const result = toolPreflightCopy({ name: 'Bash', arguments: { command: 'ls -la /tmp/example' }, result: { toolCallId: 'blocked-bash', success: false, metadata: { failureCode: AgentFailureCode.PermissionDenied } } }, zh);
    expect(result?.action).not.toContain('ls -la');
  });
  it('uses a human-facing English partial status', () => {
    expect(en.toolGroup.statusPartial).not.toBe('partial');
  });
});
