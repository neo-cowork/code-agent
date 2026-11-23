import { describe, expect, it } from 'vitest';
import { deriveSessionWorkbenchSnapshot } from '../../../src/shared/contract/sessionWorkspace';

describe('deriveSessionWorkbenchSnapshot', () => {
  it('prefers latest workbench metadata when explaining the session surface', () => {
    const snapshot = deriveSessionWorkbenchSnapshot([
      {
        timestamp: 100,
        metadata: {
          workbench: {
            workingDirectory: '/repo/code-agent',
            routingMode: 'direct',
            targetAgentNames: ['BrowserWorker'],
            selectedConnectorIds: ['mail'],
            executionIntent: {
              browserSessionMode: 'managed',
            },
          },
        },
        toolCalls: [],
        toolResults: [],
      },
    ]);

    expect(snapshot.primarySurface).toBe('browser');
    expect(snapshot.evidenceSource).toBe('message_metadata');
    expect(snapshot.workspaceLabel).toBe('code-agent');
    expect(snapshot.summary).toContain('Browser(托管)');
    expect(snapshot.summary).toContain('Direct BrowserWorker');
    expect(snapshot.summary).toContain('连接器 mail');
    expect(snapshot.labels).toContain('工作区');
    expect(snapshot.labels).toContain('Browser');
    expect(snapshot.labels).toContain('连接器:mail');
    expect(snapshot.connectorIds).toEqual(['mail']);
  });

  it('falls back to tool history when no persisted workbench metadata exists', () => {
    const snapshot = deriveSessionWorkbenchSnapshot([
      {
        timestamp: 100,
        toolCalls: [
          {
            id: 'tool-1',
            name: 'computer_use',
            arguments: {
              action: 'smart_click',
            },
          },
        ],
        toolResults: [],
      },
    ], {
      workingDirectory: '/repo/code-agent',
    });

    expect(snapshot.primarySurface).toBe('browser');
    expect(snapshot.evidenceSource).toBe('tool_history');
    expect(snapshot.summary).toContain('Browser');
    expect(snapshot.summary).toContain('工作区');
    expect(snapshot.labels).toContain('工作区');
    expect(snapshot.labels).toContain('Browser');
    expect(snapshot.recentToolNames).toEqual(['computer_use']);
  });

  it('never surfaces raw MCP server slugs in summary or labels (FB-2291)', () => {
    const snapshot = deriveSessionWorkbenchSnapshot([
      {
        timestamp: 100,
        toolCalls: [
          { id: 'tool-1', name: 'mcp__cua-driver__list_apps', arguments: {} },
          { id: 'tool-2', name: 'mcp__totally-unknown-server__do_thing', arguments: {} },
        ],
        toolResults: [],
      },
    ], {
      workingDirectory: '/repo/code-agent',
    });

    // 数据字段保留原始 id（计数/能力匹配用），只有展示层换人话
    expect(snapshot.mcpServerIds).toEqual(['cua-driver', 'totally-unknown-server']);
    // cua-driver → Computer Use 人话（与右栏 TaskPanel 上下文行同词）；未知 slug → 词组
    expect(snapshot.summary).toContain('MCP 电脑操作/Totally Unknown Server');
    expect(snapshot.summary).not.toContain('cua-driver');
    expect(snapshot.summary).not.toContain('totally-unknown-server');
    expect(snapshot.labels).toContain('MCP:电脑操作');
    expect(snapshot.labels).not.toContain('MCP:cua-driver');
  });
});
