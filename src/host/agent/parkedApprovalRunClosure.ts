// ============================================================================
// 停车审批收口后的 durable run 收尾（N-FIX-PARKED-APPROVAL-SURVIVE-RESTART-RESUME-FU1-FU1）
//
// 审批行被自动拒绝 / 批准执行一次后，原会话那条 waiting 的 root run 不会再有人推进，
// 读层会把它投影成 running（僵尸 spinner）。这里把它在 waiting 栅栏内收成 cancelled
// （投影为 interrupted）。只收口，不续跑、不派发（A′ 不变）。
// ============================================================================

import { randomUUID } from 'node:crypto';
import type { PendingApprovalRepository } from '../services/core/repositories/PendingApprovalRepository';
import type { DurableRunRepository } from '../services/core/repositories/DurableRunRepository';
import { createLogger } from '../services/infra/logger';
import { parseParkedApprovalPayload } from './parkedApprovalSurvival';

const logger = createLogger('ParkedApprovalRunClosure');

const PARKED_APPROVAL_RUN_CLOSE_REASON = 'parked_approval_closed';
const LOST_APPROVAL_REASON = 'approval_lost_on_restart';
const closureProcessInstanceId = `restart-approval-closure:${randomUUID()}`;

/** 该会话是否还有 pending 的 tool_approval 行（还有就说明 run 仍要停靠等人）。 */
export function sessionHasPendingToolApproval(
  repo: PendingApprovalRepository,
  sessionId: string,
): boolean {
  return repo.listByKindAndStatus('tool_approval', 'pending').some((row) => {
    const payload = parseParkedApprovalPayload(row.payloadJson);
    const rowSession = payload?.argsRef?.sessionId ?? payload?.sessionId ?? row.coordinatorId;
    return rowSession === sessionId;
  });
}

/**
 * 快速重启窗口：hydrate 时旧 run 还是 running 且租约未过期（生产租约 15s，正常退出不释放），
 * 此刻不能碰（可能属于活进程）。登记下来，等恢复清扫器每次认领前重试——租约过期后在被
 * recoverOnStartup 回收成 waiting 之前把它收掉。只登记「审批已被收口」的会话，幸存会话不会进来。
 */
interface CloseOptions {
  reason?: string;
  /** Restart closure must recheck durable approvals even after a lease-live deferral. */
  pendingApprovals?: PendingApprovalRepository;
}

const deferredCloses = new Map<string, {
  repository: DurableRunRepository;
  approvalRequestedAt: number;
  options: CloseOptions;
}>();

const deferredChildCloses = new Map<string, {
  repository: DurableRunRepository;
  pendingApprovals: PendingApprovalRepository;
  sessionId: string;
}>();

/** 在每次 durable 恢复认领之前调用：重试此前因租约未过期而跳过的收口。绝不抛。 */
export async function retryDeferredParkedRunCloses(now: number): Promise<void> {
  for (const [sessionId, entry] of [...deferredCloses]) {
    try {
      if (entry.options.pendingApprovals && sessionHasPendingToolApproval(entry.options.pendingApprovals, sessionId)) {
        deferredCloses.delete(sessionId);
        logger.warn('Deferred durable run close skipped', {
          sessionId, reason: entry.options.reason, skippedReason: 'pending_tool_approval',
        });
        continue;
      }
      const { closed, skippedReason } = await entry.repository.closeParkedWaitingRunForSession({
        sessionId,
        now,
        reason: entry.options.reason ?? PARKED_APPROVAL_RUN_CLOSE_REASON,
        approvalRequestedAt: entry.approvalRequestedAt,
      });
      if (closed) {
        deferredCloses.delete(sessionId);
        if (entry.options.reason) {
          logger.warn('Closed parked durable run on deferred retry after lease expiry', { sessionId, reason: entry.options.reason });
        } else logger.info('Closed parked durable run on deferred retry after lease expiry', { sessionId });
      } else if (!skippedReason?.endsWith('_lease_live')) {
        deferredCloses.delete(sessionId);
        logger.warn('Deferred parked durable run close dropped', { sessionId, reason: entry.options.reason ?? PARKED_APPROVAL_RUN_CLOSE_REASON, skippedReason });
      }
    } catch (error) {
      logger.warn('Deferred parked durable run close failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const [runId, entry] of [...deferredChildCloses]) {
    await closeInterruptedCommandTaskChild(entry.repository, entry.pendingApprovals, entry.sessionId, runId, now);
  }
}

/** 收口会话的 waiting root run；失败只 warn，绝不抛（不阻塞启动 / 点击链）。 */
export async function closeSessionParkedRun(
  repository: DurableRunRepository,
  sessionId: string,
  now: number,
  approvalRequestedAt: number,
  options: CloseOptions = {},
): Promise<boolean> {
  const reason = options.reason ?? PARKED_APPROVAL_RUN_CLOSE_REASON;
  try {
    if (options.pendingApprovals && sessionHasPendingToolApproval(options.pendingApprovals, sessionId)) {
      logger.warn('Durable run close skipped', { sessionId, reason, skippedReason: 'pending_tool_approval' });
      return false;
    }
    const { closed, skippedReason } = await repository.closeParkedWaitingRunForSession({
      sessionId,
      now,
      reason,
      approvalRequestedAt,
    });
    if (closed) {
      if (options.reason) logger.warn('Closed parked durable run after approval closure', { sessionId, reason });
      else logger.info('Closed parked durable run after approval closure', { sessionId });
    } else {
      logger.warn('Parked durable run not closed after approval closure', { sessionId, reason, skippedReason });
      if (skippedReason?.endsWith('_lease_live')) {
        const prior = deferredCloses.get(sessionId)?.approvalRequestedAt ?? approvalRequestedAt;
        deferredCloses.set(sessionId, { repository, approvalRequestedAt: Math.min(prior, approvalRequestedAt), options });
      }
    }
    return closed;
  } catch (error) {
    logger.warn('Failed to close parked durable run after approval closure', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Only the child identified by an interrupted command-task marker may be closed. No replay. */
export async function closeInterruptedCommandTaskChild(
  repository: DurableRunRepository,
  pendingApprovals: PendingApprovalRepository,
  sessionId: string,
  runId: string,
  now: number,
): Promise<boolean> {
  const context = { sessionId, runId, reason: LOST_APPROVAL_REASON };
  const skip = (skippedReason: string): false => {
    if (skippedReason !== 'child_run_lease_live') deferredChildCloses.delete(runId);
    logger.warn('Interrupted command child run not closed', { ...context, skippedReason });
    return false;
  };
  try {
    const run = await repository.get(runId);
    if (run?.sessionId !== sessionId || !run.parentRunId) return skip('child_run_identity_mismatch');
    if (run.status !== 'running' && run.status !== 'waiting' && run.status !== 'recovering') {
      return skip(`child_run_${run.status}`);
    }
    if (sessionHasPendingToolApproval(pendingApprovals, sessionId)) return skip('pending_tool_approval');
    if (!run.owner) return skip('child_run_owner_missing');
    deferredChildCloses.set(runId, { repository, pendingApprovals, sessionId });
    if (run.owner.leaseExpiresAt > now) return skip('child_run_lease_live');
    const claimed = await repository.claimAbandonedLease({
      runId,
      expectedEpoch: run.owner.epoch,
      abandonedProcessInstanceId: run.owner.processInstanceId,
      requireExpiredLease: true,
      ownerId: run.owner.ownerId,
      processInstanceId: closureProcessInstanceId,
      now,
      // Closure owns no continuing execution lease: commit the terminal immediately.
      leaseDurationMs: 0,
    });
    if (!claimed) {
      const current = await repository.get(runId);
      const leaseExpiresAt = current?.owner?.leaseExpiresAt;
      return skip(leaseExpiresAt !== undefined && leaseExpiresAt > now
        ? 'child_run_lease_live' : 'child_run_claim_fenced');
    }
    await repository.commitTerminal({
      runId,
      attempt: claimed.attempt.attempt,
      expectedOwnerEpoch: claimed.owner.epoch,
      expectedNextEventSeq: claimed.envelope.cursor.nextEventSeq,
      status: 'cancelled',
      reason: LOST_APPROVAL_REASON,
      terminalAt: now,
      event: { type: 'run_cancelled', payload: context, recordedAt: now },
    });
    deferredChildCloses.delete(runId);
    logger.warn('Closed interrupted command child run', context);
    return true;
  } catch (error) {
    logger.warn('Interrupted command child run closure failed', {
      ...context, skippedReason: 'child_run_close_failed',
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
