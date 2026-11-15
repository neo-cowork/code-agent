import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INABILITY_REPLY_CONTRACT } from '../../src/shared/inabilityReplyContract';
import { deniedToolRetryGuidance } from '../../src/host/agent/runtime/toolRunPolicy';

const FORBIDDEN_FINAL = /权限|拦下|拦住|不允许|受限|禁用|本轮|终端|工具|模式|permission|blocked|not allowed|restricted|disabled|this turn|terminal|tools|modes/i;

describe('shared inability reply contract', () => {
  it.each(['zh', 'en'] as const)('%s has exactly five rules and a neutral final message', (locale) => {
    const { guidance, finalMessage } = INABILITY_REPLY_CONTRACT[locale];
    expect(guidance.match(/^\d\. /gm)).toEqual(['1. ', '2. ', '3. ', '4. ', '5. ']);
    expect(finalMessage).not.toMatch(FORBIDDEN_FINAL);
    if (locale === 'zh') {
      expect(guidance).toContain('没有完成、该动作没有执行、相关内容没有改动');
      expect(guidance).toContain('先只读查看');
      expect(guidance).toContain('交给后台任务');
      expect(guidance).toContain('不要说权限、被拦下、被拦住、不允许、受限、禁用、当前回合或用户设置了什么');
      expect(guidance).toContain('不要提工具名、模式或终端');
      expect(guidance).toContain('只有用户明确索要命令时，才用代码块给出命令，并用一行说明它做什么');
      expect(finalMessage).toContain('没有改动');
      expect(finalMessage).toContain('操作前会先问你');
    } else {
      expect(guidance).toContain('NOT run, and that nothing was changed');
      expect(guidance).toContain('read-only first, or hand it to a background task');
      expect(guidance).toContain('Never say permission, blocked, not allowed, restricted, disabled, or this turn');
      expect(guidance).toContain('never imply the user configured');
      expect(guidance).toContain('Never name tools, modes, or the terminal');
      expect(guidance).toContain('Only when the user explicitly asks for the command, provide it in a code block with one line saying what it does');
      expect(finalMessage).toContain('nothing was changed');
      expect(finalMessage).toContain('ask you before acting');
    }
  });

  it('all five production sources import and consume the contract', () => {
    for (const file of [
      'src/host/agent/runtime/foregroundShellDenial.ts',
      'src/host/agent/runtime/bouncedToolCallSeal.ts',
      'src/host/agent/runtime/messageProcessor.ts',
      'src/host/agent/runtime/toolRunPolicy.ts',
      'src/shared/i18n/foregroundShellDenial.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toMatch(/import \{ INABILITY_REPLY_CONTRACT \} from ['"].*inabilityReplyContract['"]/);
      expect(source, file).toMatch(/INABILITY_REPLY_CONTRACT(?:\.en\.guidance|\.zh\.guidance|\[locale\]\.finalMessage)/);
    }
    const processor = readFileSync('src/host/agent/runtime/messageProcessor.ts', 'utf8');
    expect(processor).toMatch(/'<tool-run-policy>',\s*INABILITY_REPLY_CONTRACT.en.guidance,/);
  });

  it.each([true, false])('retry relay preserves the contract when unattended=%s', (unattendedTurn) => {
    const reply = deniedToolRetryGuidance({ unattendedTurn } as Parameters<typeof deniedToolRetryGuidance>[0]);
    expect(reply).toContain(INABILITY_REPLY_CONTRACT.en.guidance);
    if (unattendedTurn) expect(reply).not.toContain('AskUserQuestion');
    else expect(reply).toContain('AskUserQuestion remains available');
  });
});
