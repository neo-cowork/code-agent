import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTreeNode } from '../../../src/shared/contract/agentTree';
import type { ToolCall } from '../../../src/shared/contract';
import { buildAgentRows } from '../../../src/renderer/utils/agentRows';
import { humanizeToolStep } from '../../../src/renderer/utils/humanizeToolStep';
import { deriveDelegationPresentation } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { zh, en } from '../../../src/renderer/i18n';

const longTask = 'Read the weekly meeting notes, summarize them into three bullets, and merge the completion table into the final weekly report.';
const call: ToolCall = {
  id: 'spawn-report', name: 'spawn_agent', arguments: { role: 'coder', task: longTask },
  result: { toolCallId: 'spawn-report', success: true, output: 'accepted', metadata: { agentId: 'report-agent' } },
};
function node(role: string): AgentTreeNode {
  return {
    id: 'report-agent', role, task: longTask, status: 'completed', statusLabel: '完成',
    children: [], worktreeState: { status: 'none' }, budgetSummary: {}, evidenceRefs: [], sources: ['spawnGuard'],
  };
}
afterEach(() => useAppStore.setState({ language: 'zh' }));

describe('spawned agent naming through public entries', () => {
  it.each([
    ['coder', '编程员', 'Coder'],
    ['reviewer', '审阅员', 'Reviewer'],
    ['资料整理专家', '资料整理专家', '资料整理专家'],
    ['custom_ascii_role', '助手', 'Assistant'],
    ['constructor', '助手', 'Assistant'],
  ])('resolves %s without exposing the task or changing roleId', (role, chinese, english) => {
    for (const [language, t, expected] of [['zh', zh, chinese], ['en', en, english]] as const) {
      useAppStore.setState({ language });
      const source = node(role);
      const row = buildAgentRows({ members: [], tasks: [], nodes: [source] })[0];
      expect(row.name).toBe(expected);
      expect(row.roleId).toBe(role);
      expect(row.node?.task).toBe(longTask);
      const receipt = deriveDelegationPresentation(call, [], [source]);
      expect(receipt?.title).toBe(expected);
      expect(receipt?.title).not.toContain(longTask);
      const step = humanizeToolStep('spawn_agent', { role, task: longTask, description: longTask }, t);
      expect(step).toBe(t.toolStepHumanize.subagentSpawn.replace('{description}', expected));
      expect(step).not.toContain(longTask);
    }
  });

  it('uses the existing fallback when spawn_agent has only a long task', () => {
    expect(humanizeToolStep('spawn_agent', { task: longTask }, zh)).toBe(zh.toolStepHumanize.subagentSpawnFallback);
  });

  it.each(['Task', 'AgentSpawn', 'Explore'])('%s keeps its contracted short description', (tool) => {
    expect(humanizeToolStep(tool, { description: '整理周报', prompt: longTask, role: 'coder' }, zh))
      .toBe('启动了代理 — 整理周报');
  });

  it.each(['pending-approval', 'running', 'completed', 'failed'] as const)('uses a role label in the %s step', (status) => {
    const step = humanizeToolStep('spawn_agent', { role: 'coder', task: longTask }, zh, undefined, status);
    expect(step).toContain('编程员');
    expect(step).not.toContain(longTask);
  });

  it('preserves Team member names', () => {
    expect(buildAgentRows({
      members: [{ key: 'team-coder', roleId: 'coder', name: 'My Team Expert', status: 'running', isLead: false }],
      tasks: [], nodes: [],
    })[0].name).toBe('My Team Expert');
  });
});
