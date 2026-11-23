import { describe, expect, it } from 'vitest';
import { describeLastToolStep } from '../../../src/renderer/utils/agentActivity';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

describe('describeLastToolStep: notRun is read from the step, same wording as the foreground', () => {
  const denied = { tool: 'Bash', target: 'ls ~/Downloads', description: '看看下载文件夹里有什么', callId: 'c1', notRun: true, at: 1 };
  it('notRun step → 「未执行 · 描述」 / "Not run · description", no raw command', () => {
    expect(describeLastToolStep(denied, zh)).toBe('未执行 · 看看下载文件夹里有什么');
    const enText = describeLastToolStep({ ...denied, description: 'List what is in Downloads' }, en);
    expect(enText).toBe('Not run · List what is in Downloads');
    expect(describeLastToolStep(denied, zh)).not.toContain('~/Downloads');
  });
  it('same step without notRun is unchanged (plain description)', () => {
    const { notRun: _omit, ...ran } = denied;
    expect(describeLastToolStep(ran, zh)).toBe('看看下载文件夹里有什么');
  });
  it('notRun with an unusable description falls back to the generic not-run sentence', () => {
    expect(describeLastToolStep({ ...denied, description: undefined }, zh)).toBe(zh.toolStepHumanize.skippedCommands.one);
  });
});
