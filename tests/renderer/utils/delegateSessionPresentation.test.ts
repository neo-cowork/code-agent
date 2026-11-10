import { describe, expect, it } from 'vitest';
import { humanizeToolStep, humanizeToolGroupLabel, parseDelegateSessionReceipt } from '../../../src/renderer/utils/humanizeToolStep';
import { deriveDelegationPresentation } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import type { ToolCall } from '../../../src/shared/contract';

const privateId = 'delegation_private-fixture';
const opaqueArgs = { action: 'delegate_existing', delegationId: privateId, candidateSetId: 'candidate-private', candidateRef: 'ref-private', text: 'delegate_session active reused' };
const forbidden = /delegation_private-fixture|candidate-private|ref-private|active|reused|candidateSetId|delegate_session/;
function call(payload: Record<string, unknown>, action = 'delegate_existing'): ToolCall {
  return { id: 'call', name: 'delegate_session', arguments: { ...opaqueArgs, action }, result: {
    toolCallId: 'call', success: true, output: JSON.stringify({ delegationId: privateId, status: 'active', queuedAhead: 2, ...payload }),
  } };
}

for (const [locale, t] of [['zh', zh], ['en', en]] as const) {
  describe(`cross-conversation receipt (${locale})`, () => {
    it.each([
      [{ target: 'Q3 报告' }, 'delegate_existing', '已把任务交给「Q3 报告」', 'Sent the task to “Q3 报告”'],
      [{ target: 'Q3 报告', reused: true }, 'delegate_existing', '已送达过，未重复发送 · 「Q3 报告」', 'Already delivered; not sent again · “Q3 报告”'],
      [{ target: 'Q3 报告' }, 'create_new', '已新建对话「Q3 报告」并交给它', 'Created conversation “Q3 报告” and sent it the task'],
      [{}, 'delegate_existing', '已把任务交给另一个对话', 'Sent the task to another conversation'],
      [{}, 'unknown-action', '处理了一项跨对话委托', 'Handled a cross-conversation delegation'],
      [{ target: 'Q3 报告' }, 'correct', '已调整对「Q3 报告」的委托', 'Adjusted the delegation to “Q3 报告”'],
      [{ target: 'Q3 报告' }, 'stop', '已停止对「Q3 报告」的委托', 'Stopped the delegation to “Q3 报告”'],
      [{ target: 'Q3 报告' }, 'resume', '已恢复对「Q3 报告」的委托', 'Resumed the delegation to “Q3 报告”'],
    ] as const)('humanizes %j / %s in step and card', (payload, action, chinese, english) => {
      const tc = call(payload, action);
      const step = humanizeToolStep(tc.name, tc.arguments, t, 'delegate_session active', 'completed', undefined, { delegationReceipt: parseDelegateSessionReceipt(tc.result) });
      expect(step).toBe(locale === 'zh' ? chinese : english);
      const card = deriveDelegationPresentation(tc, [], [], t);
      expect(card).toMatchObject({ state: 'completed', title: step, outputs: [], activityIds: [] });
      expect(card?.stepCount).toBeUndefined();
      expect(step).not.toMatch(forbidden);
    });

    it.each(['pending-approval', 'running', 'failed'] as const)('uses %s forms without args or receipt names', (status) => {
      const tc = call({ target: 'hidden-target', reused: true });
      const step = humanizeToolStep(tc.name, tc.arguments, t, 'delegate_session', status, undefined, { delegationReceipt: parseDelegateSessionReceipt(tc.result) });
      expect(step).toBe(t.toolStepHumanize.statusForms[status].delegateSession.delegate_existing.replace('{target}', t.toolStepHumanize.statusForms[status].delegateSession.targetFallback));
      expect(step).not.toMatch(forbidden);
      expect(step).not.toContain('hidden-target');
      expect(humanizeToolStep('list_session_candidates', opaqueArgs, t, 'candidateSetId', status)).toBe(t.toolStepHumanize.statusForms[status].listSessionCandidates);
    });

    it('lists candidates in plain language and counts both tools in the subagent bucket', () => {
      expect(humanizeToolStep('list_session_candidates', opaqueArgs, t)).toBe(locale === 'zh' ? '已查找可委托的对话' : 'Found conversations for delegation');
      expect(humanizeToolGroupLabel(['delegate_session', 'list_session_candidates'], t)).toBe(t.toolStepHumanize.group.subagent.replace('{count}', '2'));
    });

    it.each([undefined, '', 'not JSON', '[]', 'null', '{"status":"failed"}', '{"target":"Q3 报告"}'])('rejects absent or malformed receipt %s', (output) => {
      const tc = call({ target: 'Q3 报告' });
      if (output === undefined) delete tc.result;
      else tc.result!.output = output;
      expect(deriveDelegationPresentation(tc, [], [], t)).toBeNull();
    });

    it('does not build a completed card for a rejected call, even if output or metadata looks successful', () => {
      const tc = call({ target: 'Q3 报告', reused: true });
      tc.result!.success = false;
      tc.result!.error = 'invalid_call: Nothing was delegated';
      expect(deriveDelegationPresentation(tc, [], [], t)).toBeNull();
      expect(humanizeToolStep(tc.name, tc.arguments, t, tc.result!.error, 'failed')).not.toMatch(/invalid_call|code:/);
    });
  });
}
