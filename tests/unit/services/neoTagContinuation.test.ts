import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import type { Message } from '../../../src/shared/contract/message';
import type { CreateNeoWorkCardDraftInput } from '../../../src/shared/contract/tag';
import { applyIndexes } from '../../../src/host/services/core/database/indexes';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { NeoWorkCardRepository } from '../../../src/host/services/core/repositories/NeoWorkCardRepository';
import {
  NeoWorkCardService,
  NeoWorkCardServiceError,
} from '../../../src/host/services/project/neoWorkCardService';
import {
  continueAndRunNeoWorkCard,
  launchApprovedNeoWorkCard,
  type NeoTagTaskManager,
} from '../../../src/host/services/project/neoTagRuntimeService';

const sessionsById = new Map<string, { workingDirectory?: string; messages: Message[] }>();

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getSession: vi.fn(async (sessionId: string) => ({
      id: sessionId,
      workingDirectory: sessionsById.get(sessionId)?.workingDirectory ?? '/repo/project',
      messages: sessionsById.get(sessionId)?.messages ?? [],
    })),
  }),
}));

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof applySchema>[1];

const NOW = 1_800_000_000_000;

function seedProject(db: BetterSqlite3.Database, id: string): void {
  db.prepare(`
    INSERT INTO projects (
      id, name, workspace_path, workspace_key, status, is_deleted, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', 0, ?, ?)
  `).run(id, id, `/work/${id}`, `key_${id}`, NOW, NOW);
}

function draft(): CreateNeoWorkCardDraftInput {
  return {
    projectId: 'proj_alpha',
    sourceConversationId: 'conv_A',
    sourceTurnId: 'turn_1',
    requesterUserId: 'user_1',
    title: '整理竞品报告',
    revision: {
      intent: 'plan',
      taskSummary: '整理竞品报告',
      readScope: {
        mode: 'selected_context',
        conversationIds: ['conv_A'],
      },
      writeScope: { mode: 'none' },
      modelIntent: { mode: 'inherit_current' },
      memoryPlan: { mode: 'none', entries: [], notes: [] },
      expectedOutputs: [{ kind: 'plan', title: 'Neo work card result' }],
    },
  };
}

function stubTaskManager() {
  return {
    startTask: vi.fn<NeoTagTaskManager['startTask']>(async () => {}),
    getSessionState: vi.fn(() => ({ status: 'idle' })),
  };
}

describe('continueAndRunNeoWorkCard', () => {
  let db: BetterSqlite3.Database;
  let repo: NeoWorkCardRepository;
  let service: NeoWorkCardService;

  beforeEach(() => {
    sessionsById.clear();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, noopLogger);
    applySessionsMigrations(db, noopLogger);
    applyIndexes(db);
    seedProject(db, 'proj_alpha');
    repo = new NeoWorkCardRepository(db);
    service = new NeoWorkCardService(() => repo);
  });

  afterEach(() => {
    db.close();
  });

  function createCompletedCard(): string {
    const created = service.createDraft(draft(), NOW);
    service.approveRevision({
      workCardId: created.workCard.id,
      reviewerUserId: 'user_1',
    }, NOW + 1);
    service.appendDelta({
      workCardId: created.workCard.id,
      runId: 'run_1',
      conversationId: 'conv_A',
      completed: ['first round done'],
    }, NOW + 2);
    service.acceptResult({
      workCardId: created.workCard.id,
      actorUserId: 'user_1',
    }, NOW + 3);
    return created.workCard.id;
  }

  it('appends a follow-up revision, auto-approves, launches into the current conversation', async () => {
    const workCardId = createCompletedCard();
    const taskManager = stubTaskManager();

    const result = continueAndRunNeoWorkCard({
      workCardId,
      conversationId: 'conv_B',
      turnId: 'turn_round2',
      userText: '补上定价维度',
      requesterUserId: 'user_1',
      taskManager,
      service,
      now: () => NOW + 10,
    });
    await result.run;

    const detail = service.get(workCardId)!;
    expect(detail.revisions.length).toBeGreaterThanOrEqual(2);
    expect(detail.approvedRevision?.taskSummary).toBe('补上定价维度');
    // conversationIds 自动推导：当前会话 + 源会话
    expect(new Set(detail.approvedRevision!.readScope.conversationIds))
      .toEqual(new Set(['conv_B', 'conv_A']));
    // 执行落当前会话，锚点用本轮 turnId
    expect(taskManager.startTask.mock.calls[0][0]).toBe('conv_B');
    expect(taskManager.startTask.mock.calls[0][5]).toBe('turn_round2');
    expect(detail.deltas.some((d) => d.conversationId === 'conv_B')).toBe(true);
  });

  it('rejects while the card is running (CONFLICT, friendly message)', () => {
    const created = service.createDraft(draft(), NOW);
    service.approveRevision({
      workCardId: created.workCard.id,
      reviewerUserId: 'user_1',
    }, NOW + 1);
    service.setStatus(created.workCard.id, 'working', NOW + 2);

    expect(() => continueAndRunNeoWorkCard({
      workCardId: created.workCard.id,
      conversationId: 'conv_B',
      turnId: 'turn_x',
      userText: '再来一轮',
      requesterUserId: 'user_1',
      taskManager: stubTaskManager(),
      service,
    })).toThrowError(/还在跑/);
  });

  it.each([
    { scenario: 'persisted reply', reply: '已补上结论。', nextTurn: false, expectedStatus: 'in_result_review' },
    { scenario: 'empty reply', reply: ' ', nextTurn: false, expectedStatus: 'failed' },
    { scenario: 'background-only reply', reply: '后台任务已完成。', nextTurn: false, meta: true, expectedStatus: 'failed' },
    { scenario: 'reply to a later user message', reply: '另一个请求完成了。', nextTurn: true, expectedStatus: 'failed' },
  ])('ends a same-conversation continuation in $expectedStatus for $scenario', async ({
    reply,
    meta,
    nextTurn,
    expectedStatus,
  }) => {
    const workCardId = createCompletedCard();
    const previous: Message[] = [
      { id: 'turn_1', role: 'user', content: '整理竞品报告', timestamp: 1 },
      { id: 'reply_1', role: 'assistant', content: '已整理。', timestamp: 2 },
    ];
    const anchor: Message = { id: 'turn_round2', role: 'user', content: '补上结论', timestamp: 3 };
    const liveMessages: Message[] = [
      ...previous,
      anchor,
      { id: 'reply_tool_call', role: 'assistant', content: '', timestamp: 4 },
      { id: 'reply_tool_result', role: 'tool', content: '已写入文件', timestamp: 5 },
    ];
    const taskManager = {
      ...stubTaskManager(),
      getOrCreateCurrentOrchestrator: () => ({ getMessages: () => liveMessages }),
      startTask: vi.fn<NeoTagTaskManager['startTask']>(async () => {
        const persisted = [...liveMessages];
        if (nextTurn) {
          persisted.push({ id: 'turn_3', role: 'user', content: '另一个请求', timestamp: 6 });
        }
        persisted.push({ id: 'reply_2', role: 'assistant', content: reply, timestamp: 7, isMeta: meta });
        sessionsById.set('conv_A', {
          messages: persisted,
        });
      }),
    };

    const continued = continueAndRunNeoWorkCard({
      workCardId,
      conversationId: 'conv_A',
      turnId: anchor.id,
      userText: anchor.content,
      requesterUserId: 'user_1',
      taskManager,
      service,
      now: () => NOW + 10,
    });
    const { runId } = await continued.run;

    const detail = service.get(workCardId);
    expect(detail?.workCard.status).toBe(expectedStatus);
    expect(detail?.deltas.at(-1)).toMatchObject({ runId, conversationId: 'conv_A' });
    if (expectedStatus === 'failed') {
      expect(detail?.workCard.blockedReason).toContain('没有生成最终回复');
    } else {
      expect(detail?.workCard.blockedReason).toBeFalsy();
    }
  });

  it('persists the runtime error as the failed work card blocked reason', async () => {
    const created = service.createDraft(draft(), NOW);
    service.approveRevision({
      workCardId: created.workCard.id,
      reviewerUserId: 'user_1',
    }, NOW + 1);
    const taskManager = {
      startTask: vi.fn<NeoTagTaskManager['startTask']>(async () => {}),
      getSessionState: vi.fn(() => ({
        status: 'error',
        error: 'Model route unavailable',
      })),
    };

    await launchApprovedNeoWorkCard({
      workCardId: created.workCard.id,
      taskManager,
      service,
      now: () => NOW + 2,
    });

    // 失败原因带出路（N-CHAT-EMPTY-FINAL-NO-EXIT：失败态带出路不带解释）
    const failed = service.get(created.workCard.id)?.workCard;
    expect(failed?.status).toBe('failed');
    expect(failed?.blockedReason).toContain('Model route unavailable');
    expect(failed?.blockedReason).toContain('接着做');
  });

  it('rejects closed cards (archived/cancelled)', () => {
    const created = service.createDraft(draft(), NOW);
    service.approveRevision({
      workCardId: created.workCard.id,
      reviewerUserId: 'user_1',
    }, NOW + 1);
    service.appendDelta({
      workCardId: created.workCard.id,
      runId: 'run_1',
    }, NOW + 2);
    service.archive(created.workCard.id, NOW + 3);

    expect(() => continueAndRunNeoWorkCard({
      workCardId: created.workCard.id,
      conversationId: 'conv_B',
      turnId: 'turn_x',
      userText: '再来一轮',
      requesterUserId: 'user_1',
      taskManager: stubTaskManager(),
      service,
    })).toThrowError(NeoWorkCardServiceError);
  });

  it('rejects empty follow-up text', () => {
    const workCardId = createCompletedCard();
    expect(() => continueAndRunNeoWorkCard({
      workCardId,
      conversationId: 'conv_B',
      turnId: 'turn_x',
      userText: '   ',
      requesterUserId: 'user_1',
      taskManager: stubTaskManager(),
      service,
    })).toThrowError(NeoWorkCardServiceError);
  });

  it('merges conversationIds across three conversations via prior delta ownership', async () => {
    const workCardId = createCompletedCard();
    const taskManager = stubTaskManager();
    // 第二轮：conv_B
    const second = continueAndRunNeoWorkCard({
      workCardId,
      conversationId: 'conv_B',
      turnId: 'turn_round2',
      userText: '补上定价维度',
      requesterUserId: 'user_1',
      taskManager,
      service,
      now: () => NOW + 10,
    });
    await second.run;
    // 第三轮：conv_C，应带全 [conv_C, conv_A, conv_B]
    const third = continueAndRunNeoWorkCard({
      workCardId,
      conversationId: 'conv_C',
      turnId: 'turn_round3',
      userText: '再补渠道对比',
      requesterUserId: 'user_1',
      taskManager,
      service,
      now: () => NOW + 20,
    });
    await third.run;

    const detail = service.get(workCardId)!;
    expect(new Set(detail.approvedRevision!.readScope.conversationIds))
      .toEqual(new Set(['conv_C', 'conv_A', 'conv_B']));
  });
});
