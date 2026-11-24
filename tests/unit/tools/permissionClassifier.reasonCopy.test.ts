import { describe, expect, it } from 'vitest';
import { classifyPermission } from '../../../src/host/tools/permissionClassifier';

const cases = [
  { toolName: 'Task', decision: 'approve', reason: '自动放行：派后台助手' },
  { toolName: 'spawn_agent', decision: 'approve', reason: '自动放行：派后台助手' },
  { toolName: 'AgentSpawn', decision: 'approve', reason: '自动放行：派后台助手' },
  { toolName: 'web_fetch', decision: 'approve', reason: '自动放行：联网查看' },
  { toolName: 'WebFetch', decision: 'approve', reason: '自动放行：联网查看' },
  { toolName: 'web_search', decision: 'approve', reason: '自动放行：联网查看' },
  { toolName: 'WebSearch', decision: 'approve', reason: '自动放行：联网查看' },
  { toolName: 'Read', decision: 'approve', reason: '自动放行：只读操作' },
  { toolName: 'grep', decision: 'approve', reason: '自动放行：只读操作' },
  { toolName: 'list_directory', decision: 'approve', reason: '自动放行：只读操作' },
  { toolName: 'mcp__example__create_note', decision: 'ask', reason: '外部工具可能有副作用，需要确认' },
];

describe('PermissionClassifier reason copy', () => {
  it.each(cases)('$toolName has a fixed $decision reason without tool IDs', async ({ toolName, decision, reason }) => {
    const result = await classifyPermission(toolName, {}, { workingDirectory: '/tmp' });

    expect(result.decision).toBe(decision);
    expect(result.reason).toBe(reason);
    for (const { toolName: internalName } of cases) {
      expect(result.reason.toLowerCase()).not.toContain(internalName.toLowerCase());
    }
    expect(result.hostReason?.modelText).toBe(reason);
    expect(result.hostReason?.metadata?.toolName).toBe(toolName);
  });
});
