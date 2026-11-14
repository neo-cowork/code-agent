import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');

const loggerInfo = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
const promptUserInChat = vi.hoisted(() => vi.fn());
vi.mock('../../../../../src/host/tools/utils/userQuestionPrompt', () => ({ promptUserInChat }));
vi.mock('../../../../../src/host/observability/posthogNode', () => ({ trackNode: vi.fn() }));
vi.mock('../../../../../src/host/services/infra/logger', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../../../src/host/services/infra/logger')>();
  return { ...mod, createLogger: () => ({ info: loggerInfo, warn: loggerWarn, error: () => {}, debug: () => {} }) };
});

import { applySchema } from '../../../../../src/host/services/core/database/schema';
import { getDelegationCandidateSecret } from '../../../../../src/host/services/delegation/delegationToolRuntime';
import { projectSessionCandidates } from '../../../../../src/host/services/delegation/delegationCandidates';
import { executeAskUserQuestion } from '../../../../../src/host/tools/modules/planning/askUserQuestion';
import { executeDelegateSession } from '../../../../../src/host/tools/modules/delegation/delegateSession';

const ctx = {
  sessionId: 'origin', turnId: 'turn-1', workingDir: '/workspace/origin',
  workspace: '/workspace/origin', modelConfig: { provider: 'local', model: 'test' },
  workspaceScope: { projectId: 'p', primaryRoot: '/workspace/origin', roots: [{ sourceId: 's', path: '/workspace/origin', access: 'read_write', role: 'primary' }], version: '1' },
  abortSignal: new AbortController().signal,
} as never;

const NOW = 100;
const sessions = [
  { id: 'sid-cli', title: 'CLI重构', workingDirectory: '/workspace/origin', updatedAt: NOW, sessionType: 'chat' as const, engineKind: 'native' },
  { id: 'sid-ui', title: '组件库重构', workingDirectory: '/workspace/origin', updatedAt: NOW - 1, sessionType: 'chat' as const, engineKind: 'native' },
  { id: 'sid-docs', title: '文档站', workingDirectory: '/workspace/origin', updatedAt: NOW - 2, sessionType: 'chat' as const, engineKind: 'native' },
  { id: 'sid-site-design', title: '官网改版首页设计稿会话确认', workingDirectory: '/workspace/origin', updatedAt: NOW - 3, sessionType: 'chat' as const, engineKind: 'native' },
  { id: 'sid-site-copy', title: '官网改版落地页文案专属会话', workingDirectory: '/workspace/origin', updatedAt: NOW - 4, sessionType: 'chat' as const, engineKind: 'native' },
];

let turnCounter = 0;
function setup(userMessage: string | null) {
  turnCounter += 1;
  (ctx as unknown as { turnId: string }).turnId = `turn-${turnCounter}`;
  const db = new Database(':memory:');
  applySchema(db, { info() {}, warn() {}, error() {}, debug() {} } as never);
  if (userMessage !== null) {
    db.prepare(`INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at) VALUES ('origin', 'origin', 'local', 'test', ?, ?)`).run(NOW, NOW);
    db.prepare(`INSERT INTO messages (id, session_id, role, content, timestamp) VALUES ('m-1', 'origin', 'user', ?, ?)`).run(userMessage, NOW);
  }
  const projection = projectSessionCandidates(sessions, { originSessionId: 'origin', now: NOW, secret: getDelegationCandidateSecret() });
  const refOf = (title: string) => projection.candidates[sessions.findIndex((row) => row.title === title)].candidateRef;
  (ctx as unknown as { delegationRuntime?: unknown }).delegationRuntime = {
    getDb: () => db,
    listSessions: () => sessions,
    getSessionRow: (id: string) => {
      const row = sessions.find((entry) => entry.id === id);
      return row ? { ...row, modelConfig: { provider: 'local', model: 'test' } } : null;
    },
    getWorkspaceRoots: () => ['/workspace'],
    getRuns: () => [],
    getRun: () => undefined,
    getPermissionMode: () => 'default',
    evaluateFolderTrust: async () => ({ state: 'trusted', blockedItems: 0 }),
    notifyEnqueued: vi.fn(),
    now: () => NOW,
  };
  const rows = () => ({
    delegations: (db.prepare('SELECT count(*) AS count FROM session_delegations').get() as { count: number }).count,
    queued: (db.prepare('SELECT count(*) AS count FROM queued_inputs').get() as { count: number }).count,
  });
  return { db, projection, refOf, rows };
}

afterEach(() => {
  delete process.env.CODE_AGENT_CROSS_SESSION_DELEGATION;
  (ctx as unknown as { delegationRuntime?: unknown }).delegationRuntime = undefined;
  loggerInfo.mockClear();
  loggerWarn.mockClear();
});

const allow = async () => ({ allow: true as const });

describe('delegate_session clarify guard (needs_clarification)', () => {
  it('fires on an ambiguous reference: structured rejection with display names, no row written', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, projection, refOf, rows } = setup('让重构那边看看这个报错');
    const result = await executeDelegateSession({ action: 'delegate_existing', candidateSetId: projection.candidateSetId, candidateRef: refOf('CLI重构'), text: '看看这个报错' }, ctx, allow);
    expect(result).toMatchObject({ ok: false, code: 'DELEGATION_REJECTED', meta: { code: 'needs_clarification', gate: 'none' } });
    const error = (result as { error: string }).error;
    expect(error).toContain('needs_clarification');
    expect(error).toContain('AskUserQuestion');
    expect(error).toContain('「CLI重构」');
    expect(error).toContain('「组件库重构」');
    for (const row of sessions) expect(error).not.toContain(row.id);
    expect(error).not.toContain(refOf('CLI重构'));
    expect(rows()).toEqual({ delegations: 0, queued: 0 });
    expect(loggerInfo).toHaveBeenCalledWith('[DelegateSession] outcome', expect.objectContaining({ outcome: 'rejected', code: 'needs_clarification' }));
    db.close();
  });

  it('fires when two long titles share the same prefix and the user only said the shared part', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, projection, refOf, rows } = setup('把这条备注发给官网改版那边的会话：周五前配色再对一遍');
    const result = await executeDelegateSession({ action: 'delegate_existing', candidateSetId: projection.candidateSetId, candidateRef: refOf('官网改版首页设计稿会话确认'), text: '周五前配色再对一遍' }, ctx, allow);
    expect(result).toMatchObject({ ok: false, meta: { code: 'needs_clarification', rule: 'ambiguous_reference' } });
    expect((result as { error: string }).error).toContain('「官网改版落地页文案专属会话」');
    expect(rows()).toEqual({ delegations: 0, queued: 0 });
    db.close();
  });

  // 真实作答路径：用 executeAskUserQuestion 跑完整的提问→作答/跳过，不手插账本。
  async function askUser(outcome: { status: 'answered'; answer: string } | { status: 'declined' }) {
    promptUserInChat.mockResolvedValueOnce(outcome.status === 'declined'
      ? { status: 'declined', response: { requestId: 'r', declined: true, answers: {} } }
      : { status: 'answered', response: { requestId: 'r', answers: { 目标会话: outcome.answer } } });
    const askCtx = { ...(ctx as object), logger: { debug() {}, info() {}, warn() {}, error() {} } } as never;
    return executeAskUserQuestion({
      questions: [{ header: '目标会话', question: `要发给哪个会话？#${Math.random()}`, options: [{ label: 'CLI重构', description: 'a' }, { label: '组件库重构', description: 'b' }] }],
    }, askCtx, allow);
  }

  const ambiguousCall = (projection: { candidateSetId: string }, ref: string) => ({ action: 'delegate_existing', candidateSetId: projection.candidateSetId, candidateRef: ref, text: '看看这个报错' });

  it('user declined the question: the retry is rejected again and nothing is written', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, projection, refOf, rows } = setup('让重构那边看看这个报错');
    const call = ambiguousCall(projection, refOf('CLI重构'));
    expect(await executeDelegateSession(call, ctx, allow)).toMatchObject({ ok: false, meta: { code: 'needs_clarification' } });
    const asked = await askUser({ status: 'declined' });
    expect(asked.ok).toBe(true);
    expect(await executeDelegateSession(call, ctx, allow)).toMatchObject({ ok: false, meta: { code: 'needs_clarification' } });
    expect(rows()).toEqual({ delegations: 0, queued: 0 });
    db.close();
  });

  it('user answered the chat the model retries with: delegates exactly once', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, projection, refOf, rows } = setup('让重构那边看看这个报错');
    const call = ambiguousCall(projection, refOf('CLI重构'));
    expect(await executeDelegateSession(call, ctx, allow)).toMatchObject({ ok: false, meta: { code: 'needs_clarification' } });
    await askUser({ status: 'answered', answer: 'CLI重构' });
    expect((await executeDelegateSession(call, ctx, allow)).ok).toBe(true);
    expect(rows()).toEqual({ delegations: 1, queued: 1 });
    db.close();
  });

  it('the model asked the user on its own before any guard rejection: a matching answer lets the call through, a different pick does not', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, projection, refOf, rows } = setup('让重构那边看看这个报错');
    await askUser({ status: 'answered', answer: '组件库重构' });
    expect(await executeDelegateSession(ambiguousCall(projection, refOf('CLI重构')), ctx, allow)).toMatchObject({ ok: false, meta: { rule: 'named_other_candidate' } });
    expect(rows()).toEqual({ delegations: 0, queued: 0 });
    expect((await executeDelegateSession(ambiguousCall(projection, refOf('组件库重构')), ctx, allow)).ok).toBe(true);
    expect(rows()).toEqual({ delegations: 1, queued: 1 });
    db.close();
  });

  it('user picked A but the model retries with B (or the answer is unrelated): still rejected, zero rows', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, projection, refOf, rows } = setup('让重构那边看看这个报错');
    expect(await executeDelegateSession(ambiguousCall(projection, refOf('CLI重构')), ctx, allow)).toMatchObject({ ok: false, meta: { code: 'needs_clarification' } });
    await askUser({ status: 'answered', answer: '组件库重构' });
    const wrong = await executeDelegateSession(ambiguousCall(projection, refOf('CLI重构')), ctx, allow);
    expect(wrong).toMatchObject({ ok: false, meta: { code: 'needs_clarification', rule: 'named_other_candidate' } });
    expect(rows()).toEqual({ delegations: 0, queued: 0 });
    await askUser({ status: 'answered', answer: '好的没问题' });
    expect(await executeDelegateSession(ambiguousCall(projection, refOf('CLI重构')), ctx, allow)).toMatchObject({ ok: false, meta: { code: 'needs_clarification' } });
    expect(rows()).toEqual({ delegations: 0, queued: 0 });
    db.close();
  });

  it('does not fire when the user names enough of one long title', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, projection, refOf, rows } = setup('把这条备注发给官网改版首页设计稿那个会话：周五前配色再对一遍');
    const result = await executeDelegateSession({ action: 'delegate_existing', candidateSetId: projection.candidateSetId, candidateRef: refOf('官网改版首页设计稿会话确认'), text: '周五前配色再对一遍' }, ctx, allow);
    expect(result.ok).toBe(true);
    expect(rows().delegations).toBe(1);
    db.close();
  });

  it('does not fire on a uniquely named target: delegates once', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, projection, refOf, rows } = setup('让文档站把本周变更记录整理一下');
    const result = await executeDelegateSession({ action: 'delegate_existing', candidateSetId: projection.candidateSetId, candidateRef: refOf('文档站'), text: '整理本周变更记录' }, ctx, allow);
    expect(result.ok).toBe(true);
    expect(rows()).toEqual({ delegations: 1, queued: 1 });
    expect(loggerInfo).toHaveBeenCalledWith('[DelegateSession] outcome', expect.objectContaining({ outcome: 'ok', code: 'ok' }));
    db.close();
  });

  it('fires when the model picked a different chat than the one the user named', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, projection, refOf, rows } = setup('让文档站把本周变更记录整理一下');
    const result = await executeDelegateSession({ action: 'delegate_existing', candidateSetId: projection.candidateSetId, candidateRef: refOf('CLI重构'), text: '整理本周变更记录' }, ctx, allow);
    expect(result).toMatchObject({ ok: false, meta: { code: 'needs_clarification' } });
    expect(rows()).toEqual({ delegations: 0, queued: 0 });
    db.close();
  });

  it('fires on create_new when the user never asked for a new chat', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, rows } = setup('找个会话研究一下这个通信协议');
    const result = await executeDelegateSession({ action: 'create_new', text: '研究协议设计' }, ctx, allow);
    expect(result).toMatchObject({ ok: false, meta: { code: 'needs_clarification' } });
    expect(rows()).toEqual({ delegations: 0, queued: 0 });
    db.close();
  });

  it('skips message-based rules, with a trace, when the user message is unreachable', async () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    const { db, projection, refOf, rows } = setup(null);
    const result = await executeDelegateSession({ action: 'delegate_existing', candidateSetId: projection.candidateSetId, candidateRef: refOf('CLI重构'), text: '看看这个报错' }, ctx, allow);
    expect(result.ok).toBe(true);
    expect(rows().delegations).toBe(1);
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('no readable origin user message'));
    db.close();
  });

  // N-DELEGATE-SESSION-K2-FU3-FU1-FU1：钉死真实渲染端 UserQuestionCard.tsx 回传的答案形态：
  // 1) 单选点选某一项只回传 option.label（不含 option.description，即便 description 提到了另一候选）；
  // 2) 模型缩略 label（如「首页设计稿」）同样只传 label，守卫靠唯一二元组命中目标放行；
  // 3) 点击「两个都发」（label 无候选名）或多选同时勾选两项（高分并列）均不放行单目标绑定，0 行落库。
  describe('real UserQuestionCard answer contract (label-only and 两个都发)', () => {
    const realUiSessions = [
      { id: 'sid-design', title: '官网改版-首页设计稿', workingDirectory: '/workspace/origin/design', updatedAt: NOW, sessionType: 'chat' as const, engineKind: 'native' },
      { id: 'sid-copy', title: '官网改版-落地页文案', workingDirectory: '/workspace/origin/copy', updatedAt: NOW - 1, sessionType: 'chat' as const, engineKind: 'native' },
    ];

    function setupRealUi(userMessage: string) {
      turnCounter += 1;
      const runId = `run-real-${turnCounter}`;
      (ctx as unknown as { turnId: string; runId: string }).turnId = `turn-real-${turnCounter}`;
      (ctx as unknown as { runId: string }).runId = runId;
      const db = new Database(':memory:');
      applySchema(db, { info() {}, warn() {}, error() {}, debug() {} } as never);
      db.prepare(`INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at) VALUES ('origin', 'origin', 'local', 'test', ?, ?)`).run(NOW, NOW);
      db.prepare(`INSERT INTO messages (id, session_id, role, content, timestamp) VALUES ('m-1', 'origin', 'user', ?, ?)`).run(userMessage, NOW);
      const projection = projectSessionCandidates(realUiSessions, { originSessionId: 'origin', now: NOW, secret: getDelegationCandidateSecret() });
      const refOf = (title: string) => projection.candidates[realUiSessions.findIndex((row) => row.title === title)].candidateRef;
      (ctx as unknown as { delegationRuntime?: unknown }).delegationRuntime = {
        getDb: () => db,
        listSessions: () => realUiSessions,
        getSessionRow: (id: string) => {
          const row = realUiSessions.find((entry) => entry.id === id);
          return row ? { ...row, modelConfig: { provider: 'local', model: 'test' } } : null;
        },
        getWorkspaceRoots: () => ['/workspace/origin'],
        getRuns: () => [],
        getRun: () => undefined,
        getPermissionMode: () => 'default',
        evaluateFolderTrust: async () => ({ state: 'trusted', blockedItems: 0 }),
        notifyEnqueued: vi.fn(),
        now: () => NOW,
      };
      const rows = () => ({
        delegations: (db.prepare('SELECT count(*) AS count FROM session_delegations').get() as { count: number }).count,
        targets: (db.prepare('SELECT target_session_id FROM session_delegations').all() as Array<{ target_session_id: string }>).map((r) => r.target_session_id),
      });
      return { db, projection, refOf, rows };
    }

    async function clickRealCardOption(
      options: Array<{ label: string; description: string }>,
      selectedAnswer: string | string[],
      multiSelect = false,
    ) {
      const header = '发到哪个会话';
      promptUserInChat.mockResolvedValueOnce({
        status: 'answered',
        response: { requestId: `req-${turnCounter}-${Math.random()}`, answers: { [header]: selectedAnswer } },
      });
      const askCtx = { ...(ctx as object), logger: { debug() {}, info() {}, warn() {}, error() {} } } as never;
      return executeAskUserQuestion({
        questions: [{
          header,
          question: `这条备注要发到哪个会话？#${Math.random()}`,
          multiSelect,
          options,
        }],
      }, askCtx, allow);
    }

    const cardOptions = [
      { label: '官网改版-首页设计稿', description: '设计相关会话（不发给官网改版-落地页文案）' },
      { label: '官网改版-落地页文案', description: '文案相关会话' },
      { label: '两个都发', description: '同一条备注同时转达给官网改版-首页设计稿和官网改版-落地页文案' },
    ];

    it('releases exactly the clicked session when UserQuestionCard sends option.label only (full display name or shortened suffix)', async () => {
      process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
      const { db, projection, refOf, rows } = setupRealUi('把这条备注发给官网改版那边的会话：周五前要把配色再对一遍');
      const designCall = { action: 'delegate_existing', candidateSetId: projection.candidateSetId, candidateRef: refOf('官网改版-首页设计稿'), text: '周五前要把配色再对一遍' };
      expect(await executeDelegateSession(designCall, ctx, allow)).toMatchObject({ ok: false, meta: { code: 'needs_clarification', rule: 'ambiguous_reference' } });

      // Real card sends only option.label ('官网改版-首页设计稿'), never option.description (which mentions the other chat too).
      expect((await clickRealCardOption(cardOptions, '官网改版-首页设计稿')).ok).toBe(true);
      expect((await executeDelegateSession(designCall, ctx, allow)).ok).toBe(true);
      expect(rows()).toEqual({ delegations: 1, targets: ['sid-design'] });
      expect(loggerInfo).toHaveBeenCalledWith('[DelegateSession] clarify guard passed: the user answered a clarification question in this turn and the answer matches the target');
      db.close();

      // Shortened suffix label ('首页设计稿') also uniquely scores sid-design without needing description.
      const second = setupRealUi('把这条备注发给官网改版那边的会话：周五前要把配色再对一遍');
      const shortenedOptions = [
        { label: '首页设计稿', description: '发给「官网改版-首页设计稿」这个会话' },
        { label: '落地页文案', description: '发给「官网改版-落地页文案」这个会话' },
      ];
      const secondCall = { action: 'delegate_existing', candidateSetId: second.projection.candidateSetId, candidateRef: second.refOf('官网改版-首页设计稿'), text: '周五前要把配色再对一遍' };
      expect(await executeDelegateSession(secondCall, ctx, allow)).toMatchObject({ ok: false, meta: { code: 'needs_clarification' } });
      expect((await clickRealCardOption(shortenedOptions, '首页设计稿')).ok).toBe(true);
      expect((await executeDelegateSession(secondCall, ctx, allow)).ok).toBe(true);
      expect(second.rows()).toEqual({ delegations: 1, targets: ['sid-design'] });
      second.db.close();
      delete (ctx as unknown as { runId?: string }).runId;
    });

    it('rejects retries when UserQuestionCard sends 「两个都发」 (or multi-selects both sessions), writing zero rows', async () => {
      process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
      const { db, projection, refOf, rows } = setupRealUi('把这条备注发给官网改版那边的会话：周五前统一核对一下底部版权年份');
      const designCall = { action: 'delegate_existing', candidateSetId: projection.candidateSetId, candidateRef: refOf('官网改版-首页设计稿'), text: '周五前统一核对一下底部版权年份' };
      const copyCall = { action: 'delegate_existing', candidateSetId: projection.candidateSetId, candidateRef: refOf('官网改版-落地页文案'), text: '周五前统一核对一下底部版权年份' };

      expect(await executeDelegateSession(designCall, ctx, allow)).toMatchObject({ ok: false, meta: { code: 'needs_clarification', rule: 'ambiguous_reference' } });
      expect((await clickRealCardOption(cardOptions, '两个都发')).ok).toBe(true);
      expect(await executeDelegateSession(designCall, ctx, allow)).toMatchObject({ ok: false, meta: { code: 'needs_clarification', rule: 'ambiguous_reference' } });
      expect(await executeDelegateSession(copyCall, ctx, allow)).toMatchObject({ ok: false, meta: { code: 'needs_clarification', rule: 'ambiguous_reference' } });
      expect(rows()).toEqual({ delegations: 0, targets: [] });
      db.close();

      // Multi-select / free-text naming both full titles ties at top score -> rejected as named_other_candidate.
      const tied = setupRealUi('把这条备注发给官网改版那边的会话：周五前统一核对一下底部版权年份');
      const tiedDesign = { action: 'delegate_existing', candidateSetId: tied.projection.candidateSetId, candidateRef: tied.refOf('官网改版-首页设计稿'), text: '周五前统一核对一下底部版权年份' };
      expect(await executeDelegateSession(tiedDesign, ctx, allow)).toMatchObject({ ok: false, meta: { code: 'needs_clarification' } });
      expect((await clickRealCardOption(cardOptions.slice(0, 2), ['官网改版-首页设计稿', '官网改版-落地页文案'], true)).ok).toBe(true);
      expect(await executeDelegateSession(tiedDesign, ctx, allow)).toMatchObject({ ok: false, meta: { code: 'needs_clarification', rule: 'named_other_candidate' } });
      expect(tied.rows()).toEqual({ delegations: 0, targets: [] });
      tied.db.close();
      delete (ctx as unknown as { runId?: string }).runId;
    });
  });
});
