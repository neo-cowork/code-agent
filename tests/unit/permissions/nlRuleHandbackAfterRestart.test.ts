// ============================================================================
// N-PERM-NL-RULES-K2 ⑤：handback 停车行在重启之后被处理——
//   「我做完了」：不执行，台账落「成功形」结果（用户亲自做、勿重试），不是失败；
//   「让 Neo 做这一次」：从台账执行一次；
//   对照「拒绝」：仍落失败形 denied 结果（既有行为不变）。
// 真实 SQLite pending_approvals + 真实 resumeSurvivingParkedApproval；执行端口注入替身。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { resumeSurvivingParkedApproval } from '../../../src/host/agent/parkedApprovalResume';
import { computeLedgerArgsSurvival } from '../../../src/host/agent/parkedApprovalSurvival';
import { NL_RULE_K2_TEXT } from '../../../src/shared/nlRuleRestate';
import type { Message } from '../../../src/shared/contract';
import type { PermissionResponse } from '../../../src/shared/contract/permission';

describe('handback 停车行：重启后的两键与拒绝', () => {
  let db: BetterSqlite3.Database;
  let repo: PendingApprovalRepository;
  let executions: number;
  let persistedMessages: Message[];
  let messages: Message[];
  const sessionId = 'handback-restart-session';
  const toolCallId = 'call-handback-restart';
  const requestId = 'handback-restart-1';
  const now = 5_000;

  const resume = (response: PermissionResponse) => resumeSurvivingParkedApproval({
    requestId,
    response,
    now,
    ports: {
      repo,
      loadMessages: () => messages,
      resolveWorkingDirectory: () => '/tmp',
      async executeTool() {
        executions += 1;
        return { success: true, output: `executed #${executions}` };
      },
      async persistToolMessage(_sessionId: string, message: Message) {
        persistedMessages.push(message);
        messages = [...messages, message];
      },
      now: () => now,
    },
  });

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE pending_approvals (
        id TEXT PRIMARY KEY, kind TEXT, agent_id TEXT, agent_name TEXT, coordinator_id TEXT,
        payload_json TEXT, status TEXT, submitted_at INTEGER, resolved_at INTEGER, feedback TEXT
      );
    `);
    repo = new PendingApprovalRepository(db);
    executions = 0;
    persistedMessages = [];
    messages = [
      { id: 'hb-user', role: 'user', content: '月底给供应商打款', timestamp: 1 },
      {
        id: 'hb-assistant',
        role: 'assistant',
        content: '',
        timestamp: 2,
        toolCalls: [{ id: toolCallId, name: 'Bash', arguments: { command: 'pay supplier' } }],
      },
    ] as Message[];
    repo.insert({
      id: requestId,
      kind: 'tool_approval',
      agentId: null,
      agentName: null,
      coordinatorId: sessionId,
      payload: {
        sessionId,
        toolCallId,
        tool: 'Bash',
        type: 'command',
        permissionLevel: 'medium',
        requestedAt: 1_000,
        argsRef: { sessionId, toolCallId },
        argsFingerprint: computeLedgerArgsSurvival('Bash', { command: 'pay supplier' }).argsFingerprint,
        ledgerFaithful: true,
        handback: true,
      },
      submittedAt: 1_000,
    });
  });
  afterEach(() => db.close());

  it('「我做完了」：不执行，台账落成功形结果并带「用户亲自做」说明，行收口且注明是用户自己做的', async () => {
    const outcome = await resume('user_did_it');

    expect(outcome).toMatchObject({ handled: true, status: 'denied' });
    expect(executions).toBe(0);
    expect(persistedMessages).toHaveLength(1);
    const result = persistedMessages[0].toolResults?.[0];
    expect(result).toMatchObject({
      toolCallId,
      success: true,
      output: NL_RULE_K2_TEXT.handbackDoneModelText('Bash'),
    });
    expect(result?.error).toBeUndefined();
    expect(repo.getById(requestId)).toMatchObject({
      status: 'rejected',
      feedback: 'user did it themselves after restart',
      resolvedAt: now,
    });
  });

  it('「让 Neo 做这一次」：从台账执行一次，结果成功', async () => {
    const outcome = await resume('allow');

    expect(outcome).toMatchObject({ handled: true, status: 'executed' });
    expect(executions).toBe(1);
    expect(persistedMessages[0].toolResults?.[0]).toMatchObject({ toolCallId, success: true });
    expect(repo.getById(requestId)).toMatchObject({ status: 'approved' });
  });

  it('对照「拒绝」：不执行，台账落失败形 denied 结果（既有行为不变）', async () => {
    const outcome = await resume('deny');

    expect(outcome).toMatchObject({ handled: true, status: 'denied' });
    expect(executions).toBe(0);
    const result = persistedMessages[0].toolResults?.[0];
    expect(result).toMatchObject({ toolCallId, success: false });
    expect(result?.output).toBeUndefined();
    expect(String(result?.error)).not.toBe(NL_RULE_K2_TEXT.handbackDoneModelText('Bash'));
  });
});
