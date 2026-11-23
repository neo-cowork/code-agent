import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentFailureCode } from '../../../src/shared/contract/agentFailure';
import {
  buildAgentTreeSnapshot,
  getAgentTreeSnapshot,
  type AgentTreeSpawnAgentSource,
} from '../../../src/host/agent/agentTreeService';
import { getSpawnGuard, resetSpawnGuard } from '../../../src/host/agent/spawnGuard';
import * as contextStore from '../../../src/host/context/subagentContextStore';
import { SubagentContextStore } from '../../../src/host/context/subagentContextStore';
import { BackgroundSubagentRegistry } from '../../../src/host/agent/backgroundSubagentRegistry';
import { withPersistedSubagentLifecycle } from '../../../src/host/agent/subagentContextLifecycle';
import type { EvidenceRef } from '../../../src/shared/contract/evidence';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';

const sessionRecords = vi.hoisted(() => new Map<string, { workingDirectory?: string }>());
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getSession: (id: string) => sessionRecords.get(id) ?? null,
  }),
}));

describe('agentTreeService', () => {
  it('builds a read-only tree while keeping SpawnGuard as lifecycle truth', () => {
    const snapshot = buildAgentTreeSnapshot({
      now: 1000,
      sessionId: 'session-1',
      spawnAgents: [
        {
          id: 'parent',
          role: 'coordinator',
          treeId: 'session-1',
          status: 'running',
          task: 'coordinate the long task',
          createdAt: 10,
        },
        {
          id: 'child',
          role: 'coder',
          treeId: 'session-1',
          parentId: 'parent',
          status: 'failed',
          task: 'implement the change',
          createdAt: 20,
          completedAt: 50,
          result: {
            success: false,
            output: '',
            error: 'budget exhausted',
            toolsUsed: ['Read', 'Edit'],
            iterations: 3,
            cost: 0.42,
            tokensUsed: 1800,
            failureCode: AgentFailureCode.BudgetExhausted,
          },
        },
      ],
      parallelTasks: [
        {
          taskId: 'child',
          role: 'coder',
          task: 'parallel task state says completed',
          tools: ['Read'],
          status: 'completed',
          result: {
            taskId: 'child',
            role: 'coder',
            success: true,
            output: 'parallel completed',
            toolsUsed: ['Read'],
            iterations: 1,
            startTime: 25,
            endTime: 40,
            duration: 15,
          },
        },
      ],
      contextRecords: [
        {
          sessionId: 'session-1',
          agentId: 'child',
          messages: [{
            id: 'message-tool-edit',
            role: 'assistant',
            content: '',
            timestamp: 55,
            toolCalls: [{
              id: 'tool-edit',
              name: 'Edit',
              arguments: { file_path: '/repo/src/main.ts' },
            }],
          }],
          updatedAt: 60,
          snapshot: {
            currentTokens: 1900,
            maxTokens: 4000,
            usagePercent: 47.5,
            messageCount: 4,
            warningLevel: 'normal',
            lastUpdated: 60,
            tools: ['Read', 'Edit'],
            attachments: [],
            previews: [
              {
                role: 'coder',
                contentPreview: '正在整理失败前的产物和证据',
                tokens: 120,
              },
            ],
            truncatedMessages: 0,
          },
        },
      ],
    });

    const parent = snapshot.roots.find((node) => node.id === 'parent');
    const child = snapshot.nodes.find((node) => node.id === 'child');

    expect(snapshot.generatedAt).toBe(1000);
    expect(parent?.children.map((node) => node.id)).toEqual(['child']);
    expect(child?.status).toBe('failed');
    expect(child?.statusLabel).toBe('遇到问题');
    expect(child?.failureCode).toBe(AgentFailureCode.BudgetExhausted);
    expect(child?.failureReason).toBe('可用预算已经用完');
    expect(child?.activeTool).toBe('Edit');
    expect(child?.lastToolStep).toEqual({
      tool: 'Edit',
      target: '/repo/src/main.ts',
      at: 55,
    });
    expect(child?.budgetSummary).toMatchObject({
      costUsd: 0.42,
      tokensUsed: 1900,
      maxTokens: 4000,
      usagePercent: 47.5,
      iterations: 3,
      toolCalls: 2,
    });
    expect(child?.sources).toEqual([
      'spawnGuard',
      'parallelCoordinator',
      'subagentContext',
    ]);
  });

  it('keeps the stable background id when merging its execution context after restart', () => {
    const snapshot = buildAgentTreeSnapshot({
      sessionId: 'session-1',
      backgroundAgents: [{
        agentId: 'subagent-bg-report', sessionId: 'session-1', status: 'failed',
        startedAt: 10, finishedAt: 20, failureCode: AgentFailureCode.ParentGone,
      }],
      contextRecords: [{
        sessionId: 'session-1', agentId: 'execution-report', messages: [], updatedAt: 15,
        lifecycle: { backgroundAgentId: 'subagent-bg-report', status: 'running', displayName: 'Supplier review', task: 'Compare suppliers', background: true, startedAt: 10 },
      }],
    });
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]).toMatchObject({
      id: 'execution-report', backgroundAgentId: 'subagent-bg-report',
      status: 'failed', failureCode: AgentFailureCode.ParentGone,
    });
  });

  it('attaches worktree review metadata and ADR-029 evidence refs without inventing a new evidence shape', () => {
    const evidence: EvidenceRef = {
      id: 'evidence-diff-1',
      kind: 'diff',
      ref: '/repo/.git/worktrees/coder.diff',
      source: 'agentWorktree',
      freshness: {
        capturedAtMs: 123,
        state: 'fresh',
      },
      redactionStatus: 'clean',
    };

    const snapshot = buildAgentTreeSnapshot({
      now: 200,
      worktrees: [
        {
          agentId: 'coder-1',
          status: 'preserved',
          path: '/tmp/coder-worktree',
          branch: 'codex/coder-1',
          changedFiles: [
            { path: 'src/host/agent/foo.ts', status: 'modified' },
          ],
          diffSummary: '1 file changed',
          evidenceRefs: [evidence],
          updatedAt: 150,
        },
      ],
    });

    const node = snapshot.nodes.find((item) => item.id === 'coder-1');
    expect(node?.worktreeState).toMatchObject({
      status: 'preserved',
      path: '/tmp/coder-worktree',
      branch: 'codex/coder-1',
      diffSummary: '1 file changed',
    });
    expect(node?.worktreeState.changedFiles).toEqual([
      { path: 'src/host/agent/foo.ts', status: 'modified' },
    ]);
    expect(node?.evidenceRefs).toEqual([evidence]);
    expect(node?.sources).toContain('agentWorktree');
    expect(snapshot.summary.withWorktree).toBe(1);
  });

  // --------------------------------------------------------------------------
  // 重启孤儿收口（N-STALE-AGENT-CHIP-AFTER-QUIT A）
  // subagent 都活在宿主进程内：context 记录的最后更新早于本进程启动 = 写它的
  // 执行方已死，节点不能再以 unknown（renderer 口径 = 工作中）谎报在跑。
  // 用 Date.now() 相对量构造「上一进程写的」与「本进程刚写的」两类记录。
  // --------------------------------------------------------------------------
  it.each([
    { success: false, output: '', error: 'Permission denied', code: AgentFailureCode.PermissionDenied },
    { success: false, output: '', cancellationReason: 'timeout' as const, code: AgentFailureCode.Timeout },
    { success: true, output: '', code: AgentFailureCode.Unknown },
  ])('rehydrates a registry failure ($code) with the same cause as the live receipt', async ({ code, ...result }) => {
    const dir = mkdtempSync(join(tmpdir(), 'failed-helper-context-'));
    const path = join(dir, 'context.json');
    const store = new SubagentContextStore(path);
    const storeMock = vi.spyOn(contextStore, 'getSubagentContextStore').mockReturnValue(store);
    const registry = new BackgroundSubagentRegistry();
    const sessionId = 'report-session';
    const agentId = 'report-agent';
    const backgroundAgentId = 'report-background';
    try {
      const run = withPersistedSubagentLifecycle({
        config: { name: 'Explorer', roleId: 'explore', systemPrompt: '', availableTools: [] },
        prompt: 'Summarize the project handover notes',
        context: {
          sessionId, executionAgentId: agentId,
          resolver: { getDefinition: () => undefined },
          abortSignal: new AbortController().signal, cwd: dir,
          modelConfig: { provider: 'test', model: 'test-model' },
          permission: { request: async () => true },
          events: { emit: () => undefined, detached: true, backgroundDurableAgentId: backgroundAgentId },
        },
      }, async () => ({ ...result, toolsUsed: [], iterations: 1 }));
      registry.adopt(run, { agentId: backgroundAgentId, sessionId, completionNotificationGate: { suppress: true } });
      await registry.await(backgroundAgentId);
      const live = buildAgentTreeSnapshot({ sessionId, contextRecords: store.list(sessionId), backgroundAgents: registry.list() }).nodes[0];
      const reopened = new SubagentContextStore(path);
      const contextRecords = reopened.list(sessionId);
      expect(contextRecords[0]?.lifecycle).toMatchObject({ status: 'failed', failureCode: code, failureReason: expect.any(String) });
      const replayed = buildAgentTreeSnapshot({ sessionId, contextRecords }).nodes[0];
      expect(replayed).toMatchObject({
        id: agentId, backgroundAgentId, role: 'explore', status: 'failed',
        failureCode: code, failureReason: live.failureReason,
      });
    } finally {
      storeMock.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rehydrates a stopped agent as cancelled after the executor reports failure', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-tree-restart-'));
    const storePath = join(directory, 'context.json');
    const sessionId = 'session-notes';
    const agentId = 'subagent-bg-notes';
    const now = Date.now();
    const record = {
      sessionId,
      agentId,
      messages: [],
      lifecycle: {
        status: 'running' as const,
        displayName: 'Notes researcher',
        task: 'Compare note-taking apps',
        background: true,
        startedAt: now,
      },
      updatedAt: now,
    };

    try {
      const store = new SubagentContextStore(storePath);
      store.upsert(record);
      store.markTerminal(sessionId, agentId, 'cancelled', now + 1);
      store.upsert({
        ...record,
        lifecycle: { ...record.lifecycle, status: 'failed', finishedAt: now + 2 },
        updatedAt: now + 2,
      });
      const reopened = new SubagentContextStore(storePath);
      const tree = buildAgentTreeSnapshot({ sessionId, contextRecords: reopened.list(sessionId) });

      expect(tree.nodes).toEqual([expect.objectContaining({
        id: agentId,
        status: 'cancelled',
        sources: ['subagentContext'],
      })]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  describe('restart orphan reconciliation', () => {
    function contextRecord(agentId: string, updatedAt: number) {
      return {
        sessionId: 'session-1',
        agentId,
        messages: [],
        updatedAt,
      };
    }

    it('marks a context record last updated before this process booted as cancelled, not unknown', () => {
      const snapshot = buildAgentTreeSnapshot({
        sessionId: 'session-1',
        contextRecords: [contextRecord('ghost', Date.now() - 60_000)],
      });

      const node = snapshot.nodes.find((item) => item.id === 'ghost');
      expect(node?.status).toBe('cancelled');
      expect(node?.statusLabel).toBe('已取消');
    });

    it('keeps a fresh in-process context record as unknown (better say working than dead)', () => {
      const snapshot = buildAgentTreeSnapshot({
        sessionId: 'session-1',
        contextRecords: [contextRecord('live', Date.now())],
      });

      const node = snapshot.nodes.find((item) => item.id === 'live');
      expect(node?.status).toBe('unknown');
    });

    it('a genuinely live spawnGuard agent stays running even when its context record is from a previous process', () => {
      const snapshot = buildAgentTreeSnapshot({
        sessionId: 'session-1',
        spawnAgents: [
          {
            id: 'alive',
            role: 'explore',
            treeId: 'session-1',
            status: 'running',
            task: 'scan the tree',
            createdAt: 10,
          },
        ],
        contextRecords: [contextRecord('alive', Date.now() - 60_000)],
      });

      const node = snapshot.nodes.find((item) => item.id === 'alive');
      expect(node?.status).toBe('running');
    });
  });

  it('sources.ownershipConflicts 原样带进 snapshot.summary（path/ownerAgentId/requesterAgentId）', () => {
    const snapshot = buildAgentTreeSnapshot({
      now: 300,
      ownershipConflicts: [
        { path: 'src/host/agent/foo.ts', ownerAgentId: 'coder-1', requesterAgentId: 'reviewer-1' },
      ],
    });

    expect(snapshot.summary.ownershipConflicts).toEqual([
      { path: 'src/host/agent/foo.ts', ownerAgentId: 'coder-1', requesterAgentId: 'reviewer-1' },
    ]);
  });

  it('不传 ownershipConflicts 时 snapshot.summary.ownershipConflicts 为空数组', () => {
    const snapshot = buildAgentTreeSnapshot({ now: 400 });

    expect(snapshot.summary.ownershipConflicts).toEqual([]);
  });

  describe('workdir prefix and tool-call observation leaks', () => {
    const PREFIX = '[工作目录: /Users/x/notes] 所有文件路径基于此目录。\n\n';
    const leaks = (value: unknown) => JSON.stringify(value);

    it('strips the prefix from SpawnGuard and parallel task shapes', () => {
      const snapshot = buildAgentTreeSnapshot({
        now: 1000,
        sessionId: 's',
        spawnAgents: [{ id: 'a', role: 'explore', treeId: 's', status: 'running', task: `${PREFIX}读笔记`, createdAt: 1 }],
        parallelTasks: [{ taskId: 'b', role: 'explore', task: `${PREFIX}检查 data.csv`, tools: [], status: 'pending' }],
      });
      const a = snapshot.nodes.find((n) => n.id === 'a')!;
      const b = snapshot.nodes.find((n) => n.id === 'b')!;
      expect(a.task).toBe('读笔记');
      expect(a.progress).toBe('读笔记');
      expect(b.task).toBe('检查 data.csv');
      expect(b.progress).toBe('检查 data.csv');
      expect(leaks(snapshot)).not.toContain('工作目录');
      expect(leaks(snapshot)).not.toContain('/Users/x');
    });

    it('strips the prefix from the persisted lifecycle task', () => {
      const snapshot = buildAgentTreeSnapshot({
        now: 1000,
        sessionId: 's',
        contextRecords: [{
          sessionId: 's', agentId: 'c', messages: [], updatedAt: 5,
          lifecycle: { status: 'running', displayName: 'Explorer', task: `${PREFIX}读笔记`, background: false, startedAt: 1 },
        }],
      } as never);
      expect(snapshot.nodes.find((n) => n.id === 'c')!.task).toBe('读笔记');
    });

    it('does not surface a trailing "Calling Tool(json)" observation as progress', () => {
      const snapshot = buildAgentTreeSnapshot({
        now: 1000,
        sessionId: 's',
        contextRecords: [{
          sessionId: 's', agentId: 'd', updatedAt: 5,
          messages: [
            { role: 'assistant', content: '已读完第一份', timestamp: 1 },
            { role: 'assistant', content: 'Calling Read({"file_path":"/Users/x/a.md"})', toolCalls: [{ id: 't', name: 'Read', arguments: { file_path: '/Users/x/a.md' } }], timestamp: 2 },
          ],
        }],
      } as never);
      const node = snapshot.nodes.find((n) => n.id === 'd')!;
      expect(node.progress).toBe('已读完第一份');
      expect(leaks(node)).not.toContain('Calling');
    });
  });

  // --------------------------------------------------------------------------
  // 卡片/成员视图文本泄漏（N-FIX-SUBAGENT-CARD-CWD-PREFIX-LEAK-FU1-FIX）
  // ① `Tool results:` 整段回放与 `Tool X: Success/Error/Failed` / `[cwd: …]` 行
  //   不许进 progress / lastEvent.summary；
  // ② node.task 与 progress 里的绝对路径：工作区内 → ./相对，区外（或根未知）
  //   → 只留最后两段，不带家目录前缀；
  // ③ 清洗只动展示字段：源 record/task 原样，spawn 下发给子代理的串一字不改。
  // --------------------------------------------------------------------------
  describe('tool-dump and absolute-path display cleanup', () => {
    const WS = '/Users/x/ws';
    const contextSnapshot = (previews: Array<{ role: string; contentPreview: string; tokens: number }>) => ({
      currentTokens: 10,
      maxTokens: 100,
      usagePercent: 10,
      messageCount: 1,
      warningLevel: 'normal' as const,
      lastUpdated: 60,
      tools: [],
      attachments: [],
      previews,
      truncatedMessages: 0,
    });

    const expectCleanFields = (node: { progress?: string; lastEvent?: { summary?: string } }) => {
      for (const field of [node.progress, node.lastEvent?.summary]) {
        if (field === undefined) continue;
        expect(field).not.toMatch(/^Tool \w+: (?:Success|Error|Failed)/m);
        expect(field).not.toMatch(/^Calling \S+\(/m);
        expect(field).not.toContain('Tool results:');
        expect(field).not.toContain('[cwd:');
        expect(field).not.toContain('/Users/');
      }
    };

    it('drops a "Tool results:" dump preview and keeps the earlier natural-language one', () => {
      const snapshot = buildAgentTreeSnapshot({
        now: 1000,
        sessionId: 's',
        contextRecords: [{
          sessionId: 's', agentId: 'e', messages: [], updatedAt: 60,
          snapshot: contextSnapshot([
            { role: 'coder', contentPreview: '已总结 notes.txt 的要点', tokens: 5 },
            { role: 'coder', contentPreview: 'Tool results:\nTool Grep: Success\n1:foo\n2:bar', tokens: 5 },
          ]),
        }],
      });
      const node = snapshot.nodes.find((n) => n.id === 'e')!;
      expect(node.progress).toBe('已总结 notes.txt 的要点');
      expect(node.lastEvent?.summary).toBe('已总结 notes.txt 的要点');
      expectCleanFields(node);
    });

    it('skips a trailing "Tool results:" message with a [cwd:] line, keeps the earlier reply', () => {
      const snapshot = buildAgentTreeSnapshot({
        now: 1000,
        sessionId: 's',
        contextRecords: [{
          sessionId: 's', agentId: 'f', updatedAt: 60,
          messages: [
            { role: 'assistant', content: '简报已写到输出目录', timestamp: 1 },
            {
              role: 'user',
              content: 'Tool results:\nTool Bash: Success\n[cwd: /Users/x/ws]\nhello world',
              timestamp: 2,
            },
          ],
        }],
      } as never);
      const node = snapshot.nodes.find((n) => n.id === 'f')!;
      expect(node.progress).toBe('简报已写到输出目录');
      expect(node.lastEvent?.summary).toBe('简报已写到输出目录');
      expectCleanFields(node);
    });

    it('a dump-only context record leaves progress and lastEvent.summary unset', () => {
      const snapshot = buildAgentTreeSnapshot({
        now: 1000,
        sessionId: 's',
        contextRecords: [{
          sessionId: 's', agentId: 'g', updatedAt: 60,
          messages: [{ role: 'user', content: 'Tool results:\nTool Bash: Failed\n[cwd: /Users/x/ws]\nno such file', timestamp: 2 }],
        }],
      } as never);
      const node = snapshot.nodes.find((n) => n.id === 'g')!;
      expect(node.progress).toBeUndefined();
      expect(node.lastEvent?.summary).toBeUndefined();
    });

    it('result output that is a raw dump falls back to the task instead of leaking it', () => {
      const snapshot = buildAgentTreeSnapshot({
        now: 1000,
        sessionId: 's',
        spawnAgents: [{
          id: 'h', role: 'coder', treeId: 's', status: 'completed', task: '整理 notes.txt',
          createdAt: 1, completedAt: 2,
          result: {
            success: true,
            output: 'Tool results:\nTool Read: Success\n/Users/x/ws/notes.txt contents',
            toolsUsed: ['Read'], iterations: 1,
          },
        }],
      });
      const node = snapshot.nodes.find((n) => n.id === 'h')!;
      expect(node.progress).toBe('整理 notes.txt');
      expect(node.lastEvent?.summary).toBe('已完成：整理 notes.txt');
      expectCleanFields(node);
    });

    it('result output that is a Calling-X replay line falls back to the task too', () => {
      const snapshot = buildAgentTreeSnapshot({
        now: 1000,
        sessionId: 's',
        spawnAgents: [{
          id: 'h2', role: 'coder', treeId: 's', status: 'completed', task: '写简报',
          createdAt: 1, completedAt: 2,
          result: {
            success: true,
            output: 'Calling Write({"file_path":"/tmp/outA/brief2.md","content":"# brief"})',
            toolsUsed: ['Write'], iterations: 1,
          },
        }],
      });
      const node = snapshot.nodes.find((n) => n.id === 'h2')!;
      expect(node.progress).toBe('写简报');
      expect(node.lastEvent?.summary).toBe('已完成：写简报');
      expectCleanFields(node);
    });

    it('a Calling-X-only context record leaves progress and lastEvent.summary unset', () => {
      const snapshot = buildAgentTreeSnapshot({
        now: 1000,
        sessionId: 's',
        contextRecords: [{
          sessionId: 's', agentId: 'h3', updatedAt: 60,
          messages: [{
            role: 'assistant',
            content: 'Calling Read({"file_path":"/Users/x/ws/notes.txt"})',
            timestamp: 2,
          }],
        }],
      } as never);
      const node = snapshot.nodes.find((n) => n.id === 'h3')!;
      expect(node.progress).toBeUndefined();
      expect(node.lastEvent?.summary).toBeUndefined();
    });

    it('strips embedded tool-result lines out of mixed text and keeps the remainder', () => {
      const snapshot = buildAgentTreeSnapshot({
        now: 1000,
        sessionId: 's',
        contextRecords: [{
          sessionId: 's', agentId: 'i', updatedAt: 60,
          messages: [{
            role: 'assistant',
            content: '写完了简报\nTool Write: Success\n[cwd: /Users/x/ws]\n交付在输出目录',
            timestamp: 1,
          }],
        }],
      } as never);
      const node = snapshot.nodes.find((n) => n.id === 'i')!;
      expect(node.progress).toBe('写完了简报\n交付在输出目录');
      expectCleanFields(node);
    });

    it('shortens inside-workspace absolute paths in node.task to ./relative', () => {
      const snapshot = buildAgentTreeSnapshot({
        now: 1000,
        sessionId: 's',
        workspaceRoot: WS,
        spawnAgents: [{ id: 'j', role: 'coder', treeId: 's', status: 'running', task: `整理 ${WS}/docs/a.md，并对照 ${WS} 根目录`, createdAt: 1 }],
        parallelTasks: [{ taskId: 'k', role: 'explore', task: `检查 ${WS}/data.csv`, tools: [], status: 'pending' }],
        contextRecords: [{
          sessionId: 's', agentId: 'l', messages: [], updatedAt: 5,
          lifecycle: { status: 'running', displayName: 'Writer', task: `把简报写进 ${WS}/out/brief.md`, background: false, startedAt: 1 },
        }],
      });
      expect(snapshot.nodes.find((n) => n.id === 'j')!.task).toBe('整理 ./docs/a.md，并对照 ./ 根目录');
      expect(snapshot.nodes.find((n) => n.id === 'k')!.task).toBe('检查 ./data.csv');
      expect(snapshot.nodes.find((n) => n.id === 'l')!.task).toBe('把简报写进 ./out/brief.md');
      for (const node of snapshot.nodes) expectCleanFields(node);
    });

    it('shortens outside-workspace absolute paths to the last two segments, no home prefix', () => {
      const snapshot = buildAgentTreeSnapshot({
        now: 1000,
        sessionId: 's',
        workspaceRoot: WS,
        spawnAgents: [{ id: 'm', role: 'coder', treeId: 's', status: 'running', task: '写一页简报进 /tmp/outA/summary.md', createdAt: 1 }],
      });
      const node = snapshot.nodes.find((n) => n.id === 'm')!;
      expect(node.task).toBe('写一页简报进 outA/summary.md');
      expect(node.progress).toBe('写一页简报进 outA/summary.md');
      expect(node.task).not.toContain('/tmp');
      expectCleanFields(node);
    });

    it('leaves a path-free task unchanged', () => {
      const snapshot = buildAgentTreeSnapshot({
        now: 1000,
        sessionId: 's',
        workspaceRoot: WS,
        spawnAgents: [{ id: 'n', role: 'coder', treeId: 's', status: 'running', task: '总结三份笔记的要点', createdAt: 1 }],
      });
      expect(snapshot.nodes.find((n) => n.id === 'n')!.task).toBe('总结三份笔记的要点');
    });

    it('treats every absolute path as outside when the workspace root is unknown', () => {
      const snapshot = buildAgentTreeSnapshot({
        now: 1000,
        sessionId: 's',
        spawnAgents: [{ id: 'o', role: 'coder', treeId: 's', status: 'running', task: `整理 ${WS}/docs/a.md`, createdAt: 1 }],
      });
      const node = snapshot.nodes.find((n) => n.id === 'o')!;
      expect(node.task).toBe('整理 docs/a.md');
      expect(node.task).not.toContain('/Users/');
    });

    it('shortens absolute paths inside progress and lastEvent.summary from real results', () => {
      const result: SubagentResult = {
        success: true,
        output: `已写入 ${WS}/out/brief.md`,
        toolsUsed: ['Write'], iterations: 2,
      };
      const snapshot = buildAgentTreeSnapshot({
        now: 1000,
        sessionId: 's',
        workspaceRoot: WS,
        spawnAgents: [{ id: 'p', role: 'coder', treeId: 's', status: 'completed', task: '写简报', createdAt: 1, completedAt: 2, result }],
      });
      const node = snapshot.nodes.find((n) => n.id === 'p')!;
      expect(node.progress).toBe('已写入 ./out/brief.md');
      expect(node.lastEvent?.summary).toBe('已完成：已写入 ./out/brief.md');
      expectCleanFields(node);
    });

    it('does not mutate the model-visible source task string', () => {
      const rawTask = `[工作目录: ${WS}] 所有文件路径基于此目录。\n\n整理 ${WS}/docs/a.md 并写 /tmp/outA/summary.md`;
      const source: AgentTreeSpawnAgentSource = {
        id: 'q', role: 'coder', treeId: 's', status: 'running', task: rawTask, createdAt: 1,
      };
      const snapshot = buildAgentTreeSnapshot({
        now: 1000, sessionId: 's', workspaceRoot: WS, spawnAgents: [source],
      });
      const node = snapshot.nodes.find((n) => n.id === 'q')!;
      expect(node.task).toBe('整理 ./docs/a.md 并写 outA/summary.md');
      expect(source.task).toBe(rawTask);
    });

    describe('workspace root plumbing via getAgentTreeSnapshot', () => {
      afterEach(() => {
        resetSpawnGuard();
        sessionRecords.clear();
      });

      it('resolves the root from the session workingDirectory', () => {
        sessionRecords.set('sess-ws', { workingDirectory: WS });
        getSpawnGuard().register(
          'helper-in',
          'explore',
          `整理 ${WS}/docs/a.md`,
          new Promise<SubagentResult>(() => undefined),
          new AbortController(),
          { treeId: 'sess-ws' },
        );
        const snapshot = getAgentTreeSnapshot({ sessionId: 'sess-ws' });
        const node = snapshot.nodes.find((n) => n.id === 'helper-in')!;
        expect(node.task).toBe('整理 ./docs/a.md');
      });

      it('falls back to outside handling when the session has no workingDirectory', () => {
        getSpawnGuard().register(
          'helper-out',
          'explore',
          `整理 ${WS}/docs/a.md`,
          new Promise<SubagentResult>(() => undefined),
          new AbortController(),
          { treeId: 'sess-nowhere' },
        );
        const snapshot = getAgentTreeSnapshot({ sessionId: 'sess-nowhere' });
        const node = snapshot.nodes.find((n) => n.id === 'helper-out')!;
        expect(node.task).toBe('整理 docs/a.md');
      });
    });
  });
});
