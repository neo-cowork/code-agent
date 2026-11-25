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

  it.each([
    ['MCPUnified', { action: 'status' }, undefined, 'approve', '自动放行：查看外部工具状态'],
    ['MCPUnified', { action: 'list_tools' }, undefined, 'approve', '自动放行：查看外部工具列表'],
    ['MCPUnified', { action: 'list_resources' }, undefined, 'approve', '自动放行：查看外部资源列表'],
    ['MCPUnified', { action: 'read_resource' }, undefined, 'approve', '自动放行：读取外部资源'],
    ['Process', { action: 'list' }, undefined, 'approve', '自动放行：查看后台任务列表'],
    ['Process', { action: 'poll' }, undefined, 'approve', '自动放行：查看后台任务进度'],
    ['Process', { action: 'log' }, undefined, 'approve', '自动放行：查看后台任务日志'],
    ['Process', { action: 'output' }, undefined, 'approve', '自动放行：查看后台任务输出'],
    ['Process', { action: 'write' }, undefined, 'ask', '向后台任务写入内容需要确认'],
    ['Process', { action: 'submit' }, undefined, 'ask', '向后台任务提交一行内容需要确认'],
    ['Process', { action: 'kill' }, undefined, 'ask', '停止后台任务需要确认'],
    ['Process', { action: 'unexpected_action' }, undefined, 'ask', '无法识别后台任务操作，需要确认'],
    ['Process', {}, undefined, 'ask', '无法识别后台任务操作，需要确认'],
    ['ReadOnlyExample', {}, 'read', 'approve', '自动放行：只读权限'],
  ] as const)('%s with %j uses human-readable reason copy', async (toolName, args, permissionLevel, decision, reason) => {
    const result = await classifyPermission(toolName, args, { workingDirectory: '/tmp', permissionLevel });

    expect(result.decision).toBe(decision);
    expect(result.reason).toBe(reason);
    expect(result.reason).not.toMatch(/[a-z]/i);
    expect(result.hostReason?.modelText).toBe(reason);
    expect(result.hostReason?.metadata?.toolName).toBe(toolName);
    if (decision === 'ask') expect(result.traceStep?.reason.modelText).toBe(reason);
  });
});
