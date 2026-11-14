import type { ToolHandler, ToolModule, ToolResult } from '../../../protocol/tools';
import type { ConversationEnvelope } from '../../../../shared/contract/conversationEnvelope';
import type { ModelConfig } from '../../../../shared/contract/model';
import type { RunStatus } from '../../../../shared/contract/durableRun';
import { DurableRunRepository } from '../../../services/core/repositories/DurableRunRepository';
import { QueuedInputRepository } from '../../../services/core/repositories/QueuedInputRepository';
import { SessionDelegationRepository, type SessionDelegationRecord } from '../../../services/core/repositories/SessionDelegationRepository';
import {
  commitDelegation,
  collectDeliveryFacts,
  type DelegationDeliveryFactDependencies,
} from '../../../services/delegation/delegationDelivery';
import {
  admitDelegation,
  parseDelegateSessionCall,
  type DelegationAdmissionSnapshot,
  type DelegationAdmissionResult,
  type DelegateSessionCall,
} from '../../../services/delegation/delegationAdmission';
import { deriveActionFingerprint, deriveSubmissionKey, delegationTargetIdentity } from '../../../services/delegation/delegationKeys';
import { projectSessionCandidates, resolveCandidateRef } from '../../../services/delegation/delegationCandidates';
import { evaluateClarifyAnswer, evaluateClarifyGuard, type ClarifyGuardRule } from '../../../services/delegation/delegationClarifyGuard';
import { askUserQuestionAnswerMark, askUserQuestionAnswersSince } from '../planning/askUserQuestionReplay';
import { getDelegationCandidateSecret, getDelegationToolRuntime, readOriginUserMessage, workspaceWithinRoots } from '../../../services/delegation/delegationToolRuntime';
import { isCrossSessionDelegationEnabled } from '../../../services/delegation/crossSessionDelegationFlag';
import { createLogger } from '../../../services/infra/logger';
import { trackNode } from '../../../observability/posthogNode';
import { POSTHOG_EVENTS } from '../../../../shared/observability/posthog-events';
import { delegateSessionSchema as schema } from './delegateSession.schema';

const logger = createLogger('DelegateSession');

const REJECTION_SUFFIX = ' Nothing was delegated. Ask the user with AskUserQuestion; do not retry with create_new.';

// FB-772 / FB-873：origin_turn_id 参与 submission_key 派生（session\0turn\0action\0target）。
// ctx.turnId 是单次模型推理步（agent step）id，由 streamHandler 每步重新生成；
// ctx.runId 与用户发起轮（user turn）一一对应。优先用 ctx.runId 作发起轮身份，
// 保证同一用户轮内多次迭代调用 delegate_session 命中同一 submission_key；
// 仅在 ctx.runId 缺失时回退 ctx.turnId，二者双缺则拒绝并告警，绝不回退跨轮共享常量。
function originTurnIdOf(ctx: Parameters<ToolHandler['execute']>[1]): string {
  const runId = typeof ctx.runId === 'string' && ctx.runId.trim().length > 0 ? ctx.runId : undefined;
  if (runId !== undefined) return runId;
  const turnId = typeof ctx.turnId === 'string' && ctx.turnId.trim().length > 0 ? ctx.turnId : undefined;
  if (turnId !== undefined) return turnId;
  logger.warn('[DelegateSession] origin turn identity missing: ctx.turnId is empty and ctx.runId is empty; refusing to derive a submission key (no cross-turn constant fallback)');
  throw new Error('delegate_session requires an origin turn identity; both ctx.turnId and ctx.runId are empty');
}

// ADR-072 E6 打点：meta 只带 code/gate 两个枚举值（无内容、无 id、无路径），
// 记录层从这里读，避免解析模型可见的 error 文本。
function rejection(code: string, detail: string, gate?: string): ToolResult<string> {
  return { ok: false, code: 'DELEGATION_REJECTED', error: `${code}: ${detail}.${REJECTION_SUFFIX}`, meta: { code, gate: gate ?? 'none' } };
}

// 回执给模型的用户向状态描述：模型只复述这句，不得引用 status/runStatus 原始枚举。
function plainStateOf(status: SessionDelegationRecord['status'], runStatus?: RunStatus): string {
  if (runStatus === 'completed') return 'The target session has finished this request.';
  if (runStatus === 'failed') return 'The target session tried this request but it failed.';
  if (runStatus === 'cancelled') return 'The target session stopped before finishing this request.';
  if (runStatus) return 'The target session is still working on this request.';
  if (status === 'terminal_observed') return 'The target session has finished this request.';
  return 'The target session has received this request and will handle it shortly.';
}

function successfulOutput(input: { targetSessionId: string; delegationId: string; targetName: string; queuedAhead: number; status: SessionDelegationRecord['status']; runStatus?: RunStatus; reused?: true }): ToolResult<string> {
  const payload = {
    delegationId: input.delegationId,
    target: input.targetName,
    status: input.status,
    ...(input.runStatus ? { runStatus: input.runStatus } : {}),
    queuedAhead: input.queuedAhead,
    ...(input.reused ? {
      reused: true as const,
      stateDescription: plainStateOf(input.status, input.runStatus),
      message: 'This request was already delivered; no second request was sent. Tell the user it was already delivered, and describe the current state using the wording in stateDescription. Never quote the raw status or runStatus values to the user. Do not retry or describe this as a rejection or an idempotency conflict.',
    } : {}),
  };
  return {
    ok: true,
    output: JSON.stringify(payload),
    // 目标会话 id 只进 meta（渲染端「查看目标会话」按钮用），绝不进模型可见的 output。
    meta: { ...payload, targetSessionId: input.targetSessionId },
  };
}

async function reusedReceipt(
  delegationId: string,
  runtime: ReturnType<typeof getDelegationToolRuntime>,
): Promise<ToolResult<string>> {
  const db = runtime.getDb();
  const row = db ? new SessionDelegationRepository(db).get(delegationId) : null;
  if (!row || !db) return rejection('target_unavailable', 'delegation row is unavailable');
  // INV-6: replay only reads the receipt; withdrawn work is never revived.
  if (row.status === 'stopped' || row.status === 'aborted' || row.status === 'superseded') {
    return rejection('delegation_not_active', `existing delegation ${row.delegationId} is ${row.status}; it is not revived on retry, re-issue the task as a new delegation`);
  }
  const run = row.targetRunId ? await new DurableRunRepository(db).get(row.targetRunId) : null;
  return successfulOutput({
    targetSessionId: row.targetSessionId,
    delegationId: row.delegationId,
    targetName: runtime.getSessionRow(row.targetSessionId)?.title ?? 'session',
    queuedAhead: 0, status: row.status, runStatus: run?.status, reused: true,
  });
}

function modelConfigOf(value: unknown): ModelConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const provider = (value as { provider?: unknown }).provider;
  const model = (value as { model?: unknown }).model;
  return typeof provider === 'string' && typeof model === 'string' ? { provider, model } : undefined;
}

function envelopeFrom(row: SessionDelegationRecord, db: Parameters<typeof commitDelegation>[0]): ConversationEnvelope | null {
  if (!row.targetQueuedInputId) return null;
  const queued = new QueuedInputRepository(db).getById(row.targetQueuedInputId);
  if (!queued) return null;
  try {
    return JSON.parse(queued.envelopeJson) as ConversationEnvelope;
  } catch {
    return null;
  }
}

function isQueuedRow(row: SessionDelegationRecord, db: Parameters<typeof commitDelegation>[0]): boolean {
  return Boolean(row.targetQueuedInputId && new QueuedInputRepository(db).getById(row.targetQueuedInputId)?.status === 'queued');
}

async function buildSnapshot(
  call: DelegateSessionCall,
  ctx: Parameters<ToolHandler['execute']>[1],
  runtime: ReturnType<typeof getDelegationToolRuntime>,
  targetSessionId: string | null,
  candidateSet: ReturnType<typeof projectSessionCandidates> | undefined,
  hostWorkspaceRoot: string | undefined,
  existingDelegation: DelegationAdmissionSnapshot['existingDelegation'],
  chainDelegation?: DelegationAdmissionSnapshot['chainDelegation'],
): Promise<DelegationAdmissionSnapshot> {
  const target = targetSessionId ? runtime.getSessionRow(targetSessionId) : null;
  const targetWorkspace = target?.workingDirectory?.trim() || (call.action === 'create_new' ? hostWorkspaceRoot ?? null : null);
  let folderTrust: DelegationAdmissionSnapshot['target']['folderTrust'] = null;
  if (targetWorkspace) {
    try {
      const evaluated = await runtime.evaluateFolderTrust(targetWorkspace);
      folderTrust = { state: evaluated.state, blockedItems: evaluated.blockedItems };
    } catch {
      folderTrust = { error: true };
    }
  }
  const roots = [...runtime.getWorkspaceRoots(), ...(ctx.workspaceScope?.roots.map((root) => root.path) ?? [])];
  const runs = runtime.getRuns();
  const db = runtime.getDb();
  const delegatedRunIds = targetSessionId && db
    ? new SessionDelegationRepository(db).listByTargetSession(targetSessionId).flatMap((row) => row.targetRunId ? [row.targetRunId] : [])
    : [];
  let userQueuedOrSendingRows = 0;
  if (targetSessionId && db) {
    const queued = new QueuedInputRepository(db).listBySession(targetSessionId);
    const delegations = new SessionDelegationRepository(db);
    userQueuedOrSendingRows = queued.filter((row) =>
      (row.status === 'queued' && row.pausedReason === null || row.status === 'sending')
      && delegations.getByTargetQueuedInputId(row.id) === null,
    ).length;
  }
  return {
    originSessionId: ctx.sessionId,
    originTurnId: originTurnIdOf(ctx),
    ...(hostWorkspaceRoot ? { hostWorkspaceRoot } : {}),
    ...(candidateSet ? {
      candidates: {
        candidateSetId: candidateSet.candidateSetId,
        candidateRefs: candidateSet.candidates.map((candidate) => candidate.candidateRef),
        candidateSessionIds: candidateSet.sessionIds,
      },
    } : {}),
    target: {
      sessionId: targetSessionId,
      sessionExists: call.action === 'create_new' ? true : target !== null,
      isArchived: target?.isArchived === true,
      isDeleted: target?.isDeleted === true,
      sessionType: target?.sessionType ?? 'chat',
      engineKind: target?.engineKind ?? 'native',
      workspaceRoot: targetWorkspace,
      workspaceAuthorized: workspaceWithinRoots(targetWorkspace, roots),
      permissionMode: targetSessionId ? runtime.getPermissionMode(targetSessionId) : runtime.getPermissionMode(ctx.sessionId),
      folderTrust,
    },
    runningTurns: runs.map((run) => ({ sessionId: run.context.sessionId, workspaceRoot: run.context.workspace ?? null })),
    targetActiveRunId: targetSessionId ? runtime.getRun(targetSessionId)?.context.runId ?? null : null,
    delegatedRunIds,
    userQueuedOrSendingRows,
    existingDelegation,
    ...(chainDelegation ? { chainDelegation } : {}),
  };
}

// 守卫已在本轮拒绝过的发起轮：key = 发起会话 + 发起轮身份，value = 拒绝时刻的作答流水 mark + 规则名。
// 用户通过 AskUserQuestion 作答后（答案是工具输出，不是 messages 行），同一轮的重试不能再被
// 同一条原始消息拒绝，否则本轮永远委托不出去。放行证据只认「拒绝之后真的有一次完整作答」
// （askUserQuestionAnswersSince，来自作答记录路径；跳过/无界面/残缺答案走不到），并且答案
// 文本必须点到这次要发的会话（evaluateClarifyAnswer）。没作答、点了别家、答案无关都继续拒。
const clarificationAsked = new Map<string, { mark: number; rule: ClarifyGuardRule }>();
const CLARIFICATION_TRACK_LIMIT = 256;

// ADR-072 D2/D3 确定性守卫：模型只给建议，目标不清时不绑定，改回一个可点选的问题。
// 返回 null = 放行进准入门；否则是 needs_clarification 拒绝（候选只给显示名，不含 id）。
function clarifyGuardRejection(
  call: DelegateSessionCall,
  ctx: Parameters<ToolHandler['execute']>[1],
  runtime: ReturnType<typeof getDelegationToolRuntime>,
): ToolResult<string> | null {
  if (call.action !== 'delegate_existing' && call.action !== 'create_new') return null;
  const userMessage = readOriginUserMessage(runtime.getDb(), ctx.sessionId, ctx.sourceMessageId);
  if (userMessage === null) {
    logger.warn('[DelegateSession] clarify guard message-based rules skipped: the session has no readable origin user message');
    return null;
  }
  const scope = ctx.runId ?? ctx.turnId ?? '';
  const turnKey = `${ctx.sessionId}\0${originTurnIdOf(ctx)}`;
  const asked = clarificationAsked.get(turnKey);
  const secret = getDelegationCandidateSecret();
  const projection = projectSessionCandidates(runtime.listSessions(), {
    originSessionId: ctx.sessionId,
    now: runtime.now(),
    secret,
    isRunning: (sessionId) => runtime.getRun(sessionId) !== undefined,
  });
  let chosenIndex: number | null = null;
  if (call.action === 'delegate_existing') {
    // 引用解不开 / 集合过期交给 G3 原样拒绝（码与 gate 不变）。
    const resolved = resolveCandidateRef({ candidateSetId: call.candidateSetId, candidateRef: call.candidateRef }, projection, secret);
    if (!resolved.ok) return null;
    chosenIndex = projection.sessionIds.indexOf(resolved.sessionId);
  }
  const guardCandidates = projection.candidates.map((candidate) => ({ shortName: candidate.shortName, workspaceName: candidate.workspaceName }));
  // 作答证据：拒绝之后的作答，或（模型自己先问了用户、还没被守卫拒过时）本轮任何一次完整作答。
  const answers = askUserQuestionAnswersSince(ctx.sessionId, scope, asked?.mark ?? 0);
  let verdict = evaluateClarifyGuard({ action: call.action, candidates: guardCandidates, chosenIndex, userMessage });
  if (verdict.kind === 'proceed') return null;
  // 没任务内容（vague_task_text）只认「守卫拒绝之后」的作答，无关的早先作答不算。
  const answerConsulted = answers.length > 0 && (asked !== undefined || verdict.rule !== 'vague_task_text');
  if (answerConsulted) {
    verdict = evaluateClarifyAnswer({ rule: asked?.rule ?? verdict.rule, action: call.action, candidates: guardCandidates, chosenIndex, answerText: answers.join('\n') });
    if (verdict.kind === 'proceed') {
      clarificationAsked.delete(turnKey);
      logger.info('[DelegateSession] clarify guard passed: the user answered a clarification question in this turn and the answer matches the target');
      return null;
    }
  }
  // 作答后仍被拒（点了别家/无关答案）不推进 mark：用户已经答过的那次作答，对之后改对的重试仍然有效。
  if (!answerConsulted) {
    if (clarificationAsked.size >= CLARIFICATION_TRACK_LIMIT) clarificationAsked.delete(clarificationAsked.keys().next().value as string);
    clarificationAsked.set(turnKey, { mark: askUserQuestionAnswerMark(), rule: asked?.rule ?? verdict.rule });
  }
  const names = verdict.candidateNames.length > 0 ? ` Candidate chats (display names): ${verdict.candidateNames.map((name) => `「${name}」`).join('、')}.` : '';
  return {
    ok: false,
    code: 'DELEGATION_REJECTED',
    error: `needs_clarification: the target chat is not clear enough to send this safely.${names} Nothing was delegated. Ask the user which chat they mean with AskUserQuestion, using those display names as the options (plain words, no ids); do not retry delegate_session until the user answers.`,
    meta: { code: 'needs_clarification', gate: 'none', rule: verdict.rule },
  };
}

function parseArgs(args: Record<string, unknown>) {
  const normalized: Record<string, unknown> = { ...args };
  if (typeof args.text === 'string' && args.content === undefined) normalized.content = args.text;
  delete normalized.text;
  return parseDelegateSessionCall(normalized);
}

type AdmissionOutcome = {
  result: DelegationAdmissionResult;
  row: SessionDelegationRecord | null;
  targetSessionId?: string | null;
  targetIdentity?: string;
  snapshot?: DelegationAdmissionSnapshot;
};
type AdmittedOutcome = AdmissionOutcome & {
  result: Extract<DelegationAdmissionResult, { kind: 'admitted' }>;
  snapshot: DelegationAdmissionSnapshot;
};

async function admissionFor(
  call: DelegateSessionCall,
  ctx: Parameters<ToolHandler['execute']>[1],
  runtime: ReturnType<typeof getDelegationToolRuntime>,
): Promise<AdmissionOutcome> {
  let projection: ReturnType<typeof projectSessionCandidates> | undefined;
  let targetSessionId: string | null = null;
  const secret = getDelegationCandidateSecret();
  if (call.action === 'delegate_existing') {
    projection = projectSessionCandidates(runtime.listSessions(), {
      originSessionId: ctx.sessionId,
      now: runtime.now(),
      secret,
      isRunning: (sessionId) => runtime.getRun(sessionId) !== undefined,
    });
    const resolved = resolveCandidateRef({ candidateSetId: call.candidateSetId, candidateRef: call.candidateRef }, projection, secret);
    if (!resolved.ok) {
      return {
        result: { kind: 'rejected', code: resolved.code, gate: 'G3', detail: 'candidate reference is stale or ambiguous' },
        row: null,
      };
    }
    targetSessionId = resolved.sessionId;
    if (call.candidateSetId && call.candidateSetId !== projection.candidateSetId) {
      return {
        result: { kind: 'rejected', code: 'candidate_set_stale', gate: 'G3', detail: 'candidate set is stale' },
        row: null,
      };
    }
  }
  if (call.action === 'create_new') targetSessionId = null;
  if (call.action === 'correct' || call.action === 'stop' || call.action === 'resume') {
    const db = runtime.getDb();
    const row = db ? new SessionDelegationRepository(db).get(call.delegationId ?? '') : null;
    const chain = row && {
      delegationId: row.delegationId,
      originSessionId: row.originSessionId,
      targetSessionId: row.targetSessionId,
      status: row.status,
    };
    targetSessionId = row?.targetSessionId ?? null;
    const snapshot = await buildSnapshot(call, ctx, runtime, targetSessionId, undefined, undefined, null, chain ?? undefined);
    return { result: admitDelegation(call, snapshot), row, targetSessionId, snapshot };
  }
  const targetIdentity = delegationTargetIdentity({ action: call.action, sessionId: targetSessionId ?? undefined, hostWorkspaceRoot: ctx.workspaceScope?.primaryRoot ?? ctx.workspace });
  const db = runtime.getDb();
  const existing = db ? new SessionDelegationRepository(db).getBySubmissionKey(deriveSubmissionKey({
    originSessionId: ctx.sessionId,
    originTurnId: originTurnIdOf(ctx),
    action: call.action,
    targetIdentity,
  })) : null;
  const snapshot = await buildSnapshot(call, ctx, runtime, targetSessionId, projection, call.action === 'create_new' ? ctx.workspaceScope?.primaryRoot ?? ctx.workspace : undefined, existing ? {
    delegationId: existing.delegationId,
    originSessionId: existing.originSessionId,
    targetSessionId: existing.targetSessionId,
    actionFingerprint: existing.actionFingerprint,
    status: existing.status,
  } : null);
  return { result: admitDelegation(call, snapshot), row: existing, targetSessionId, targetIdentity, snapshot };
}

export async function executeDelegateSession(
  args: Record<string, unknown>,
  ctx: Parameters<ToolHandler['execute']>[1],
  canUseTool: Parameters<ToolHandler['execute']>[2],
  _onProgress?: Parameters<ToolHandler['execute']>[3],
): Promise<ToolResult<string>> {
  const result = await runDelegateSession(args, ctx, canUseTool, _onProgress);
  recordDelegateSessionOutcome(args, result);
  return result;
}

// ADR-072 E6：每个到达工具体的调用记录恰好一次结局（PostHog + host log 各一），
// 属性恰好 outcome/code/gate/action 四个。FEATURE_DISABLED / PERMISSION_DENIED
// 不是 gate 拒绝，不记录。
function recordDelegateSessionOutcome(args: Record<string, unknown>, result: ToolResult<string>): void {
  if (!result.ok && result.code !== 'DELEGATION_REJECTED') return;
  const meta = (result as { meta?: { code?: unknown; gate?: unknown } }).meta;
  const parsed = parseArgs(args);
  const props = {
    outcome: result.ok ? 'ok' : 'rejected',
    code: typeof meta?.code === 'string' ? meta.code : result.ok ? 'ok' : 'unknown',
    gate: typeof meta?.gate === 'string' ? meta.gate : 'none',
    action: parsed.ok ? parsed.call.action : 'unknown',
  };
  trackNode(POSTHOG_EVENTS.DELEGATE_SESSION_OUTCOME, props);
  logger.info('[DelegateSession] outcome', props);
}

async function runDelegateSession(
  args: Record<string, unknown>,
  ctx: Parameters<ToolHandler['execute']>[1],
  canUseTool: Parameters<ToolHandler['execute']>[2],
  _onProgress?: Parameters<ToolHandler['execute']>[3],
): Promise<ToolResult<string>> {
  if (!isCrossSessionDelegationEnabled()) return { ok: false, code: 'FEATURE_DISABLED', error: 'cross-session delegation is disabled' };
  const permission = await canUseTool(schema.name, args);
  if (!permission.allow) return { ok: false, code: 'PERMISSION_DENIED', error: permission.reason };
  const parsed = parseArgs(args);
  if (!parsed.ok) return rejection(parsed.code, parsed.detail);
  const runtime = getDelegationToolRuntime(ctx);
  const call = parsed.call;
  try {
    const guarded = clarifyGuardRejection(call, ctx, runtime);
    if (guarded) return guarded;
    const admission = await admissionFor(call, ctx, runtime);
    if (admission.result.kind === 'rejected') return rejection(admission.result.code, admission.result.detail, admission.result.gate);
    if (admission.result.kind === 'reused') {
      return reusedReceipt(admission.result.delegationId, runtime);
    }
    if (call.action === 'stop' || call.action === 'resume' || call.action === 'correct') {
      return executeChain(call, admission.row ?? null, ctx, runtime);
    }
    if (admission.result.kind !== 'admitted' || !admission.snapshot) return rejection('invalid_call', 'admission did not produce a delegation');
    return executeNewDelegation(call, admission as AdmittedOutcome, ctx, runtime);
  } catch (error) {
    return rejection('invalid_call', error instanceof Error ? error.message : 'delegation host operation failed');
  }
}

async function executeNewDelegation(
  call: DelegateSessionCall,
  admission: AdmittedOutcome,
  ctx: Parameters<ToolHandler['execute']>[1],
  runtime: ReturnType<typeof getDelegationToolRuntime>,
): Promise<ToolResult<string>> {
  const db = runtime.getDb();
  if (!db) return rejection('target_unavailable', 'database is unavailable');
  const targetId = admission.result.targetSessionId ?? runtime.randomId('session_');
  const target = runtime.getSessionRow(targetId);
  const targetName = target?.title ?? (call.action === 'create_new' ? (call.content?.trim().slice(0, 40) || 'new session') : 'session');
  const envelope: ConversationEnvelope = {
    content: call.content ?? '',
    sessionId: targetId,
    options: target?.modelConfig || modelConfigOf(ctx.modelConfig) ? { modelSpec: target?.modelConfig ?? modelConfigOf(ctx.modelConfig) } : undefined,
  };
  const delegationId = runtime.randomId('delegation_');
  const input = {
    delegationId,
    originSessionId: ctx.sessionId,
    originTurnId: originTurnIdOf(ctx),
    disposition: call.action as 'delegate_existing' | 'create_new',
    targetSessionId: targetId,
    submissionKey: admission.result.submissionKey,
    actionFingerprint: admission.result.actionFingerprint,
    envelope,
    now: runtime.now(),
  } as const;
  let committed;
  if (call.action === 'create_new') {
    const manager = runtime.getSessionManager();
    const modelConfig = modelConfigOf(ctx.modelConfig);
    if (!modelConfig) return rejection('invalid_call', 'create_new requires a host model configuration');
    await manager.createSession({
      id: targetId,
      title: call.content?.slice(0, 80) || 'Delegated session',
      modelConfig,
      workingDirectory: ctx.workspaceScope?.primaryRoot ?? ctx.workspace,
      commit: (write) => { committed = commitDelegation(db, input, write); },
    });
  } else {
    committed = commitDelegation(db, input);
  }
  if (!committed) return rejection('target_unavailable', 'delegation transaction did not commit');
  // rework r2：同轮并行提交撞 submission_key 且指纹不同（G4 的竞态形态）——
  // 新正文没有入队，绝不能回 status:active 的成功回执，否则第二个任务被静默
  // 丢弃且模型不会重试。与非竞态 G4 拒绝保持同一形状。
  if (committed.kind === 'idempotency_conflict') {
    return rejection('idempotency_conflict', 'same submission key with a different payload');
  }
  if (committed.kind === 'reused') return reusedReceipt(committed.delegationId, runtime);
  runtime.notifyEnqueued(targetId);
  return successfulOutput({ targetSessionId: targetId, delegationId: committed.delegationId, targetName, status: 'active', queuedAhead: admission.snapshot.userQueuedOrSendingRows });
}

async function executeChain(
  call: DelegateSessionCall,
  row: SessionDelegationRecord | null,
  ctx: Parameters<ToolHandler['execute']>[1],
  runtime: ReturnType<typeof getDelegationToolRuntime>,
): Promise<ToolResult<string>> {
  const db = runtime.getDb();
  if (!db || !row) return rejection('invalid_call', 'delegation row is missing');
  const repository = new SessionDelegationRepository(db);
  const queued = new QueuedInputRepository(db);
  const now = runtime.now();
  if (call.action === 'stop') {
    if (row.targetQueuedInputId && isQueuedRow(row, db)) queued.pauseQueued(row.targetQueuedInputId, 'delegation_stopped', now);
    const handle = runtime.getRun(row.targetSessionId);
    if (handle?.cancel && row.targetRunId && handle.context.runId === row.targetRunId) await handle.cancel('user');
    repository.markStopped(row.delegationId, { reason: 'user' }, now);
    return successfulOutput({ targetSessionId: row.targetSessionId, delegationId: row.delegationId, targetName: runtime.getSessionRow(row.targetSessionId)?.title ?? 'session', status: 'stopped', queuedAhead: 0 });
  }
  if (call.action === 'resume') {
    if (!row.targetQueuedInputId) return rejection('invalid_call', 'delegation has no queued input');
    const targetRecord = queued.getById(row.targetQueuedInputId);
    if (!targetRecord) return rejection('invalid_call', 'queued input is missing');
    // rework r1：resume 只复活还能投的行。retracted/failed 行永远不进
    // getNextDispatchable，早拒才能避免「报成功但任务静默丢失、账本滞留 active」。
    if (targetRecord.status !== 'queued') {
      const hint = targetRecord.status === 'failed'
        ? 'requeue the row first, then resume'
        : targetRecord.status === 'sending'
          ? 'wait for the in-flight delivery to settle, then resume'
          : 'a retracted input cannot be revived; delegate the task again';
      return rejection('invalid_call', `queued input is ${targetRecord.status}, not queued; ${hint}`);
    }
    const deps: DelegationDeliveryFactDependencies = {
      getDb: runtime.getDb,
      getSessionRow: runtime.getSessionRow,
      getPermissionMode: runtime.getPermissionMode,
      evaluateFolderTrust: runtime.evaluateFolderTrust,
      getActiveRunId: (sessionId) => runtime.getRun(sessionId)?.context.runId ?? null,
    };
    const facts = await collectDeliveryFacts(deps, { sessionId: row.targetSessionId, queuedInputId: row.targetQueuedInputId, originSessionId: row.originSessionId });
    const delivery = (await import('../../../services/delegation/delegationAdmission')).recheckForDelivery(facts.snapshot);
    if (delivery.kind !== 'deliver') {
      // rework r1：pause 分支携带真实 gate（G1/G2/G11/G12/INV-2），必须随 meta
      // 记录，E6 的 code × gate 分布才不失真；wait 是排队不是门拒绝，按工单
      // 口径不传 gate（记 none）。
      if (delivery.kind === 'pause') return rejection(delivery.code, delivery.detail, delivery.gate);
      return rejection('target_busy', 'another delegation is running');
    }
    queued.unpauseQueued(row.targetQueuedInputId, now);
    repository.markResumed(row.delegationId, now);
    runtime.notifyEnqueued(row.targetSessionId);
    return successfulOutput({ targetSessionId: row.targetSessionId, delegationId: row.delegationId, targetName: runtime.getSessionRow(row.targetSessionId)?.title ?? 'session', status: 'active', queuedAhead: 0 });
  }
  if (call.action === 'correct') {
    if (!call.content) return rejection('invalid_call', 'correct requires task text');
    const oldEnvelope = envelopeFrom(row, db);
    const newTarget = row.targetSessionId;
    const target = runtime.getSessionRow(newTarget);
    const targetIdentity = `session:${newTarget}`;
    const submissionKey = deriveSubmissionKey({ originSessionId: ctx.sessionId, originTurnId: originTurnIdOf(ctx), action: 'correct', targetIdentity: `delegation:${row.delegationId}` });
    // The new queue row is a normal delegate_existing delivery; its stored
    // disposition must match the fingerprint used by K1C at delivery time.
    const actionFingerprint = deriveActionFingerprint({ action: 'delegate_existing', targetIdentity, content: call.content, attachmentRefs: [] });
    const newId = runtime.randomId('delegation_');
    const envelope: ConversationEnvelope = { ...(oldEnvelope ?? { sessionId: newTarget }), content: call.content, sessionId: newTarget, options: target?.modelConfig ? { modelSpec: target.modelConfig } : oldEnvelope?.options };
    const committed = commitDelegation(
      db,
      { delegationId: newId, originSessionId: ctx.sessionId, originTurnId: originTurnIdOf(ctx), disposition: 'delegate_existing', targetSessionId: newTarget, submissionKey, actionFingerprint, envelope, supersedesDelegationId: row.delegationId, now },
      undefined,
      {
        supersededDelegationId: row.delegationId,
        retractQueuedInputId: row.targetQueuedInputId && isQueuedRow(row, db) ? row.targetQueuedInputId : null,
      },
    );
    // rework r2：correct 与新委托共用提交缝，竞态撞键同样不得回成功；输家在
    // 赢家已完成的撤回/supersede 副作用之前早退。
    if (committed.kind === 'idempotency_conflict') {
      return rejection('idempotency_conflict', 'same submission key with a different payload');
    }
    if (committed.kind === 'reused') return reusedReceipt(committed.delegationId, runtime);
    runtime.notifyEnqueued(newTarget);
    return successfulOutput({ targetSessionId: newTarget, delegationId: committed.delegationId, targetName: target?.title ?? 'session', status: 'active', queuedAhead: 0 });
  }
  return rejection('invalid_call', 'unsupported chain action');
}

class DelegateSessionHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(...args: Parameters<ToolHandler<Record<string, unknown>, string>['execute']>) {
    return executeDelegateSession(...args);
  }
}

export const delegateSessionModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler: () => new DelegateSessionHandler(),
};
