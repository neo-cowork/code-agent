// ============================================================================
// ADR-067 刀 3：denialRegistry 单元测试
// 指纹规范化（同义同指纹 / 异形不同指纹 / 不可解析不登记）+ (sessionId, 指纹) 键
// + 容量有界（每 session FIFO 50 / 20 sessions）+ ask-approved 复位
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import {
  computeActionFingerprint,
  getDenialRegistry,
} from '../../../src/host/security/denialRegistry';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import * as sessionManagerModule from '../../../src/host/services/infra/sessionManager';
import { userDeniedGoalStickyError } from '../../../src/host/tools/toolPermissionClassification';
import { createCLIPermissionHandler, setInteractiveApprovalProvider } from '../../../src/cli/permissionPolicy';
import type { AppSettings, AgentEvent } from '../../../src/shared/contract';
import { PermissionRequestReason } from '../../../src/shared/contract/permission';

vi.unmock('better-sqlite3');

const CWD = '/tmp/work';

type DenialRecordEntry = Parameters<ReturnType<typeof getDenialRegistry>['record']>[0];

function entry(sessionId: string, fingerprint: string, index = 0): DenialRecordEntry {
  return {
    sessionId,
    fingerprint,
    toolName: 'Bash',
    summary: fingerprint,
    reason: 'user',
    timestamp: 1000 + index,
    byUser: true,
  };
}

describe('computeActionFingerprint（指纹规范化真源复用）', () => {
  it('bash：引号/空白等同义改写同指纹（canonicalizeCommand 唯一文本形）', () => {
    const bare = computeActionFingerprint('Bash', { command: "find . -name dummy.tmp -delete" }, CWD);
    const quoted = computeActionFingerprint('Bash', { command: "find . -name 'dummy.tmp' -delete" }, CWD);
    const spaced = computeActionFingerprint('Bash', { command: 'find   .  -name   dummy.tmp   -delete' }, CWD);
    expect(bare).toBeTruthy();
    expect(quoted).toBe(bare);
    expect(spaced).toBe(bare);
  });

  it('bash：改参异形不同指纹（误伤边界）', () => {
    const a = computeActionFingerprint('Bash', { command: 'find . -name a.tmp -delete' }, CWD);
    const b = computeActionFingerprint('Bash', { command: 'find . -name b.tmp -delete' }, CWD);
    expect(a).not.toBe(b);
  });

  it('bash：静态不可解析（命令替换）不登记——该路径本就 agent 无关地 fail-closed', () => {
    expect(computeActionFingerprint('Bash', { command: 'rm -rf $(pwd)' }, CWD)).toBeNull();
  });

  it('文件路径类：cwd 归一；不同工具不同指纹', () => {
    const write = computeActionFingerprint('Write', { file_path: 'out.txt' }, CWD);
    const edit = computeActionFingerprint('Edit', { file_path: 'out.txt' }, CWD);
    expect(write).toBe(`file:Write:${CWD}/out.txt`);
    expect(edit).toBe(`file:Edit:${CWD}/out.txt`);
    expect(write).not.toBe(edit);
  });

  it('external 出站：复用 standingGrantTarget 收件人集合规范化', () => {
    const fingerprint = computeActionFingerprint('mail_send', {
      to: ['boss@example.com'],
      cc: ['team@example.com'],
      subject: 'x',
    }, CWD);
    expect(fingerprint).toContain('external:mail_send:');
    expect(fingerprint).toContain('boss@example.com');
    expect(fingerprint).toContain('team@example.com');
    // 收件人不同 → 指纹不同（bcc 加人 = 另一动作，必重新审批的同口径）
    const widened = computeActionFingerprint('mail_send', {
      to: ['boss@example.com'],
      bcc: ['outsider@example.com'],
    }, CWD);
    expect(widened).not.toBe(fingerprint);
  });

  it('无法规范化的工具形状返回 null', () => {
    expect(computeActionFingerprint('some_custom_tool', { foo: 1 }, CWD)).toBeNull();
  });
});

describe('DenialRegistry（(sessionId, 指纹) 键与容量有界）', () => {
  beforeEach(() => getDenialRegistry().clearAll());

  it('同 session 命中，跨 session 不共享', () => {
    const registry = getDenialRegistry();
    registry.record(entry('s1', 'fp-1'));
    expect(registry.find('s1', 'fp-1')).toBeTruthy();
    expect(registry.find('s2', 'fp-1')).toBeUndefined();
  });

  it('clear（ask-approved 复位）后不再命中；bucket 空则 session 移除', () => {
    const registry = getDenialRegistry();
    registry.record(entry('s1', 'fp-1'));
    registry.clear('s1', 'fp-1');
    expect(registry.find('s1', 'fp-1')).toBeUndefined();
  });

  it('每 session FIFO 50：溢出逐最旧，最新仍命中', () => {
    const registry = getDenialRegistry();
    for (let i = 0; i < 60; i += 1) {
      registry.record(entry('s1', `fp-${i}`, i));
    }
    expect(registry.find('s1', 'fp-0')).toBeUndefined();
    expect(registry.find('s1', 'fp-9')).toBeUndefined();
    expect(registry.find('s1', 'fp-10')).toBeTruthy();
    expect(registry.find('s1', 'fp-59')).toBeTruthy();
  });

  it('同指纹重插刷新 FIFO 序（最新一条有效）', () => {
    const registry = getDenialRegistry();
    for (let i = 0; i < 50; i += 1) {
      registry.record(entry('s1', `fp-${i}`, i));
    }
    registry.record(entry('s1', 'fp-0', 999));
    for (let i = 50; i < 60; i += 1) {
      registry.record(entry('s1', `fp-${i}`, i));
    }
    // fp-0 被重插到最新，不再是最旧——fp-1 才是该被逐出的
    expect(registry.find('s1', 'fp-0')).toBeTruthy();
    expect(registry.find('s1', 'fp-1')).toBeUndefined();
  });

  it('session 表 FIFO 20：跨 session 内存有界', () => {
    const registry = getDenialRegistry();
    for (let i = 0; i < 25; i += 1) {
      registry.record(entry(`s${i}`, 'fp', i));
    }
    expect(registry.find('s0', 'fp')).toBeUndefined();
    expect(registry.find('s4', 'fp')).toBeUndefined();
    expect(registry.find('s5', 'fp')).toBeTruthy();
    expect(registry.find('s24', 'fp')).toBeTruthy();
  });
});

describe('goal registry is independent of fingerprint availability', () => {
  beforeEach(() => getDenialRegistry().clearAll());
  it('null fingerprint still records a real user denial, isolated by family/session/message', async () => {
    const registry = getDenialRegistry();
    const base = { sessionId: 'goal', sourceMessageId: 'user-1', toolName: 'custom_action', enabled: true };
    expect(computeActionFingerprint(base.toolName, { foo: 'bar' }, CWD)).toBeNull();
    await registry.observeApproval({
      ...base,
      ask: async () => ({ approved: false, denialSource: 'user' as const }),
    });
    let humanPrompts = 0;
    const runHandler = (overrides: Partial<typeof base> = {}) => {
      const cur = { ...base, ...overrides };
      return registry.observeApproval({
        ...cur,
        ask: async () => {
          const refused = registry.refuseIfGoalDenied({ sessionId: cur.sessionId, tool: cur.toolName });
          if (refused) return refused;
          humanPrompts++;
          return { approved: true, denialSource: undefined };
        },
      });
    };
    expect(await runHandler()).toMatchObject({ approved: false, denialSource: 'user' });
    expect(humanPrompts).toBe(0);
    for (const delta of [{ toolName: 'another_action' }, { sessionId: 'elsewhere' }, { sourceMessageId: 'user-2' }]) {
      expect(await runHandler(delta)).toMatchObject({ approved: true });
    }
    expect(humanPrompts).toBe(3);
  });
  it('cannot infer consent or a global lock if both source message and run identity are absent', async () => {
    const registry = getDenialRegistry();
    const input = { sessionId: 'legacy', toolName: 'Bash', enabled: true };
    await registry.observeApproval({
      ...input,
      ask: async () => ({ approved: false, denialSource: 'user' as const }),
    });
    let asked = false;
    await registry.observeApproval({
      ...input,
      ask: async () => {
        const refused = registry.refuseIfGoalDenied({ sessionId: input.sessionId, tool: input.toolName });
        if (refused) return refused;
        asked = true;
        return { approved: true, denialSource: undefined };
      },
    });
    expect(asked).toBe(true);
  });
});

describe('OrchestratorPermissionIsland.requestPermission goal-sticky after automatic approvals', () => {
  let db: InstanceType<typeof Database>;
  let repo: PendingApprovalRepository;
  let grantRoot: string;
  let outsideRoot: string;

  beforeEach(() => {
    getDenialRegistry().clearAll();
    resetPermissionModeManager();
    setInteractiveApprovalProvider(null);
    db = new Database(':memory:');
    db.exec(`CREATE TABLE pending_approvals (
      id TEXT PRIMARY KEY, kind TEXT, agent_id TEXT, agent_name TEXT, coordinator_id TEXT,
      payload_json TEXT, status TEXT, submitted_at INTEGER, resolved_at INTEGER, feedback TEXT
    )`);
    repo = new PendingApprovalRepository(db);
    grantRoot = mkdtempSync(nodePath.join(tmpdir(), 'goal-grant-'));
    outsideRoot = mkdtempSync(nodePath.join(tmpdir(), 'goal-outside-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPermissionModeManager();
    setInteractiveApprovalProvider(null);
    db.close();
    rmSync(grantRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  });

  it('preserves dev-auto-approve and auto-approve-level after a real-user family denial, while refusing a human prompt', async () => {
    const registry = getDenialRegistry();
    const sessionId = 'r2-interactive-session';
    const scope = { sessionId, sourceMessageId: 'msg-1', enabled: true };
    let devMode = false;
    let levelAutoApprove = false;
    const events: AgentEvent[] = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: () => ({
        permissions: { autoApprove: { execute: levelAutoApprove } },
      }) as unknown as AppSettings,
      isDevModeAutoApproveEnabled: () => devMode,
      getExecutionTopology: () => 'single_agent',
      hasApprovalUi: () => true,
      injectedPendingApprovalRepo: repo,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'permission_request' && !event.data.resolved) {
          queueMicrotask(() => {
            island.handlePermissionResponse(event.data.id, 'deny');
          });
        }
      },
    });

    const firstDenial = await registry.observeApproval({
      ...scope,
      toolName: 'Bash',
      ask: async () => {
        const res = await island.requestPermission({
          sessionId,
          type: 'command',
          tool: 'Bash',
          details: { command: 'rm -f a.tmp' },
        });
        return { ...res, denialSource: res.denialSource };
      },
    });
    expect(firstDenial.approved).toBe(false);
    expect(firstDenial.denialSource).toBe('user');
    expect(events).toHaveLength(1);

    devMode = true;
    const devResult = await registry.observeApproval({
      ...scope,
      toolName: 'Bash',
      ask: async () => {
        const res = await island.requestPermission({
          sessionId,
          type: 'command',
          tool: 'Bash',
          details: { command: 'echo dev-ok' },
        });
        return { ...res, denialSource: res.denialSource };
      },
    });
    expect(devResult).toEqual({ approved: true, approvalSource: 'dev-auto-approve' });

    devMode = false;
    levelAutoApprove = true;
    const levelResult = await registry.observeApproval({
      ...scope,
      toolName: 'Bash',
      ask: async () => {
        const res = await island.requestPermission({
          sessionId,
          type: 'command',
          tool: 'Bash',
          details: { command: 'echo level-ok' },
        });
        return { ...res, denialSource: res.denialSource };
      },
    });
    expect(levelResult).toEqual({ approved: true, approvalSource: 'auto-approve-level' });

    levelAutoApprove = false;
    const refusedHuman = await registry.observeApproval({
      ...scope,
      toolName: 'bash',
      ask: async () => {
        const res = await island.requestPermission({
          sessionId,
          type: 'command',
          tool: 'bash',
          details: { command: 'find . -name b.tmp -delete' },
        });
        return { ...res, denialSource: res.denialSource };
      },
    });
    expect(refusedHuman).toEqual({
      approved: false,
      denialSource: 'user',
      message: userDeniedGoalStickyError('bash').modelText,
    });
    expect(events).toHaveLength(1);
    expect(db.prepare('SELECT * FROM pending_approvals').all()).toHaveLength(0);
  });

  it('preserves unattended-readonly MCP and schedule-write-grant after real-user family denials, while refusing human-parked retries with zero new rows', async () => {
    const registry = getDenialRegistry();
    const sessionId = 'r2-unattended-session';
    const scope = { sessionId, runId: 'run-cron-1', enabled: true };
    const realGrantRoot = realpathSync(grantRoot);
    getPermissionModeManager().markUnattendedSession(sessionId);
    vi.spyOn(sessionManagerModule, 'getSessionManager').mockReturnValue({
      getSession: async (id: string) => (id === sessionId
        ? { id, origin: { kind: 'cron', metadata: { writeGrantRoot: realGrantRoot } }, workingDirectory: realGrantRoot }
        : null),
    } as unknown as ReturnType<typeof sessionManagerModule.getSessionManager>);

    const island = new OrchestratorPermissionIsland({
      getSettings: () => ({
        permissions: { autoApprove: { read: false, write: false, execute: false, network: false } },
      }) as unknown as AppSettings,
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => false,
      injectedPendingApprovalRepo: repo,
      onEvent: (event) => {
        if (event.type === 'permission_request' && !event.data.resolved) {
          queueMicrotask(() => {
            island.resolveParkedApproval(event.data.id, 'deny');
          });
        }
      },
    });

    const mcpTool = 'mcp__lark__calendar_v4_calendarEvent_list';
    const forcedMcpDenial = await registry.observeApproval({
      ...scope,
      toolName: mcpTool,
      ask: async () => {
        const res = await island.requestPermission({
          sessionId,
          type: 'command',
          tool: mcpTool,
          forceConfirm: true,
          details: {},
        });
        return { ...res, denialSource: res.denialSource };
      },
    });
    expect(forcedMcpDenial.approved).toBe(false);
    expect(forcedMcpDenial.denialSource).toBe('user');
    expect(db.prepare('SELECT * FROM pending_approvals').all()).toHaveLength(1);

    const readonlyMcp = await registry.observeApproval({
      ...scope,
      toolName: mcpTool,
      ask: async () => {
        const res = await island.requestPermission({
          sessionId,
          type: 'command',
          tool: mcpTool,
          details: {},
        });
        return { ...res, denialSource: res.denialSource };
      },
    });
    expect(readonlyMcp).toEqual({ approved: true, approvalSource: 'unattended-readonly' });
    expect(db.prepare('SELECT * FROM pending_approvals').all()).toHaveLength(1);

    const outOfGrantDenial = await registry.observeApproval({
      ...scope,
      toolName: 'Write',
      ask: async () => {
        const res = await island.requestPermission({
          sessionId,
          type: 'file_write',
          tool: 'Write',
          forceConfirm: true,
          forceConfirmBoundaryOnly: true,
          reasonCode: PermissionRequestReason.FileWriteOutsideWorkspace,
          details: { path: nodePath.join(outsideRoot, 'first.txt') },
        });
        return { ...res, denialSource: res.denialSource };
      },
    });
    expect(outOfGrantDenial.approved).toBe(false);
    expect(outOfGrantDenial.denialSource).toBe('user');
    const rowsBeforeRefusal = db.prepare('SELECT * FROM pending_approvals').all();
    expect(rowsBeforeRefusal).toHaveLength(2);

    const inGrantWrite = await registry.observeApproval({
      ...scope,
      toolName: 'Write',
      ask: async () => {
        const res = await island.requestPermission({
          sessionId,
          type: 'file_write',
          tool: 'Write',
          forceConfirm: true,
          forceConfirmBoundaryOnly: true,
          reasonCode: PermissionRequestReason.FileWriteOutsideWorkspace,
          details: { path: nodePath.join(realGrantRoot, 'report.md') },
        });
        return { ...res, denialSource: res.denialSource };
      },
    });
    expect(inGrantWrite).toEqual({ approved: true, approvalSource: 'schedule-write-grant' });
    expect(db.prepare('SELECT * FROM pending_approvals').all()).toEqual(rowsBeforeRefusal);

    const outOfGrantRetry = await registry.observeApproval({
      ...scope,
      toolName: 'Write',
      ask: async () => {
        const res = await island.requestPermission({
          sessionId,
          type: 'file_write',
          tool: 'Write',
          forceConfirm: true,
          forceConfirmBoundaryOnly: true,
          reasonCode: PermissionRequestReason.FileWriteOutsideWorkspace,
          details: { path: nodePath.join(outsideRoot, 'second-different.txt') },
        });
        return { ...res, denialSource: res.denialSource };
      },
    });
    expect(outOfGrantRetry).toEqual({
      approved: false,
      denialSource: 'user',
      message: userDeniedGoalStickyError('Write').modelText,
    });
    expect(db.prepare('SELECT * FROM pending_approvals').all()).toEqual(rowsBeforeRefusal);
  });

  it('preserves CLI auto-mode safe approval while guarding interactive CLI prompts', async () => {
    const registry = getDenialRegistry();
    const scope = { sessionId: 'cli-session', sourceMessageId: 'cli-msg-1', enabled: true };
    const prompts: string[] = [];
    setInteractiveApprovalProvider(async (req) => {
      prompts.push(String(req.details?.command ?? req.tool));
      return { approved: false, denialSource: 'user' };
    });
    const handler = createCLIPermissionHandler({ permissionMode: 'auto', workingDirectory: grantRoot, warn: () => {} });

    const first = await registry.observeApproval({
      ...scope,
      toolName: 'Bash',
      ask: async () => {
        const res = await handler({ sessionId: scope.sessionId, type: 'dangerous_command', tool: 'Bash', details: { command: 'rm -rf build' } });
        return { ...res, denialSource: res.denialSource };
      },
    });
    expect(first.approved).toBe(false);
    expect(prompts).toEqual(['rm -rf build']);

    const safeAuto = await registry.observeApproval({
      ...scope,
      toolName: 'Bash',
      ask: async () => {
        const res = await handler({ sessionId: scope.sessionId, type: 'command', tool: 'Bash', details: { command: 'pwd' } });
        return { ...res, denialSource: res.denialSource };
      },
    });
    expect(safeAuto).toEqual({ approved: true, approvalSource: 'cli-auto-approve' });
    expect(prompts).toEqual(['rm -rf build']);

    const secondDanger = await registry.observeApproval({
      ...scope,
      toolName: 'Bash',
      ask: async () => {
        const res = await handler({ sessionId: scope.sessionId, type: 'dangerous_command', tool: 'Bash', details: { command: 'rm -rf dist' } });
        return { ...res, denialSource: res.denialSource };
      },
    });
    expect(secondDanger).toEqual({
      approved: false,
      denialSource: 'user',
      message: userDeniedGoalStickyError('Bash').modelText,
    });
    expect(prompts).toEqual(['rm -rf build']);
  });
});
