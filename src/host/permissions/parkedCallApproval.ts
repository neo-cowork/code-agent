// ============================================================================
// 停靠前已确认、但从未执行的调用凭证（N-ENV-ASSIST-S3-RESUME-REST2-FU2，owner 11-23 选 A）
//
// mail_draft 的确认卡在连接器执行之前就问过了；Mail 自动化被拒（-1743）后整轮停靠，
// 授权后同一 run 自动续跑，模型重发同一封草稿。那次确认对应的调用从没执行过，续跑执行的
// 就是同一次被确认的调用：确认与执行仍一对一，所以这里记一份一次性凭证，续跑时消费一次即作废。
// 不是给 C1 connector_external_write 的信任边界开例外：其余所有硬门（blocked、目标已被拒）
// 仍然优先，分类器 / 权限记忆 / autoApprove 对 trustBoundary 的既有拒绝不受影响。
//
// 匹配：同 sessionId + 同 runId + 同工具名 + 参数规范化（键排序）后 sha256 一致；10 分钟
// 有效期（从停靠记录起算）；run 终态清理。只放进程内存：服务重启后凭证消失，回到再问一次
// （宁可多问，不可漏问）。
// ============================================================================

import { createHash } from 'node:crypto';
import type { AgentEvent, Message } from '../../shared/contract';
import type { EnvAssistNotice } from '../../shared/contract/envAssist';
import { PARKED_CALL_APPROVAL_TTL_MS } from '../../shared/constants/envResume';
import { getDenialRegistry } from '../security/denialRegistry';
import { emitExternalAgentEvent } from '../services/agentEngine/agentEngineEventSink';
import { createLogger } from '../services/infra/logger';
import { getSessionManager } from '../services/infra/sessionManager';

const logger = createLogger('ParkedCallApproval');
const PARKED_APPROVAL_TOOL = 'mail_draft';
/** runId → credentials (one per distinct argument hash). */
const credentials = new Map<string, Map<string, { sessionId: string; expiresAt: number }>>();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const argsHash = (args: unknown) => createHash('sha256').update(canonical(args)).digest('hex');

export function recordParkedCallApproval(input: { sessionId?: string; runId?: string; tool: string; args: unknown }): void {
  if (!input.sessionId || !input.runId || input.tool !== PARKED_APPROVAL_TOOL) return;
  const perRun = credentials.get(input.runId) ?? new Map<string, { sessionId: string; expiresAt: number }>();
  perRun.set(argsHash(input.args), { sessionId: input.sessionId, expiresAt: Date.now() + PARKED_CALL_APPROVAL_TTL_MS });
  credentials.set(input.runId, perRun);
}

export function clearParkedCallApprovals(runId: string): void {
  credentials.delete(runId);
}

/**
 * Called where the trust-boundary gate would force a fresh card. `blockedByOtherGate` carries every
 * hard gate except the trust boundary itself; any of them (or a denied goal) still forces the card.
 */
export function resolveParkedCallApproval(input: {
  toolName: string; params: unknown; sessionId: string | undefined; runId: string | undefined;
  sourceMessageId?: string; turnOrigin?: ReadonlyArray<{ runId?: string }>; blockedByOtherGate: boolean;
}): { ledgerReason: string; traceRule: string; traceDetail: string } | null {
  if (input.blockedByOtherGate || !input.runId || !input.sessionId || input.toolName !== PARKED_APPROVAL_TOOL) return null;
  const perRun = credentials.get(input.runId);
  const hash = argsHash(input.params);
  const credential = perRun?.get(hash);
  if (!perRun || !credential) return null;
  if (credential.sessionId !== input.sessionId || credential.expiresAt < Date.now()) {
    perRun.delete(hash);
    return null;
  }
  if (getDenialRegistry().refuseIfGoalDenied(
    { sessionId: input.sessionId, sourceMessageId: input.sourceMessageId, runId: input.runId, turnOrigin: input.turnOrigin, tool: input.toolName, details: {} },
    { log: false },
  )) return null;
  perRun.delete(hash);
  if (perRun.size === 0) credentials.delete(input.runId);
  return { ledgerReason: 'parked_call_approval', traceRule: 'parked_call_approval', traceDetail: `停靠前已确认、未执行的同一调用：${input.toolName}` };
}

/** One plain line in the chat after the resumed run executed the already-confirmed call (copy lives in renderer i18n). */
export async function publishParkedReuseNotice(input: { sessionId?: string; runId?: string; toolCallId?: string }): Promise<void> {
  if (!input.sessionId || !input.runId) return;
  try {
    const notice: EnvAssistNotice = {
      id: `${input.runId}|parked_reuse|${input.toolCallId ?? ''}`, sessionId: input.sessionId, runId: input.runId,
      class: 'perm_automation', target: { id: 'mail', labelKey: 'env.target.mail' }, phase: 'resolved',
      sentenceKey: 'env.reused.mail', resume: { mode: 'auto' }, updatedAt: Date.now(),
    };
    const message: Message = { id: `env-assist:${notice.id}`, role: 'assistant', content: '', timestamp: notice.updatedAt, metadata: { envAssist: notice } };
    await getSessionManager().addMessageToSession(input.sessionId, message);
    const events: AgentEvent[] = [{ type: 'env_assist_notice', data: notice }, { type: 'message', data: message }];
    for (const event of events) emitExternalAgentEvent(input.sessionId, event);
  } catch (error) {
    logger.warn('Parked-call reuse notice failed to publish', { error: error instanceof Error ? error.message : String(error) });
  }
}
