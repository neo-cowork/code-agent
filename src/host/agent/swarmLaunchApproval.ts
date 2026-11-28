// ============================================================================
// Swarm Launch Approval Gate - 并行编排启动前确认
// ============================================================================
// 施工单二 B：遵从会话权限档——
// headless 自动批 → 全只读立即批 → acceptEdits/bypassPermissions 立即批
// → 其余档等待用户（无超时自动拒/批；cancel*/hydrate 仍可排干 pending）。
// 无人值守会话（cron/heartbeat/channel）例外：没有人盯着会话卡，等待必须有出口——
// 停车进待过目收件箱 + 发需要授权通知，cron/heartbeat 30 分钟、channel 24h 无人应答自动拒，
// run 照常收尾。交互会话不设计时器。
// 计时器与等待者都只活在发起审批的这个进程里：重启后被 attachPersistence 载回的行没有
// 等待者也没有计时器（hasLiveWaiter=false），收件箱不列、应答不投递，等 durable 恢复
// 用同一 id 重新发起后才重新可答（cron/heartbeat 的行启动时已直接作废，见 hydrate）。
// ============================================================================

import { AppWindow } from '../platform';
import { createLogger } from '../services/infra/logger';
import { withApprovalTrace } from '../telemetry/telemetryService';
import type {
  SwarmLaunchRequest,
  SwarmLaunchTaskPreview,
  SwarmRunRef,
  SwarmRunScope,
} from '../../shared/contract/swarm';
import { getSwarmRunScopeKey } from '../../shared/contract/swarm';
import type { PendingApprovalRepository } from '../services/core/repositories/PendingApprovalRepository';
import { getPermissionModeManager } from '../permissions/modes';
import { INTERACTION_TIMEOUTS } from '../../shared/constants/timeouts';
import { LAUNCH_APPROVAL_TOOL } from '../../shared/constants/pendingApproval';
import { noteUnattendedApprovalDenial } from './unattendedApprovalTerminal';
import { getSwarmEventEmitter } from './swarmEventPublisher';
import { holdStallClock } from './stallObserver';

const logger = createLogger('SwarmLaunchApprovalGate');

/**
 * Run-record code for a team launch nobody answered in time. Deliberately not the tool-approval
 * timeout code: cronFailurePolicy treats that one as permanent and disables the job. Kept out of
 * the model-facing reason so it cannot be echoed into the user's report.
 */
const TEAM_LAUNCH_APPROVAL_EXPIRED = 'TEAM_LAUNCH_APPROVAL_EXPIRED';

function buildLaunchExpiryFeedback(waitedMs: number): string {
  return `Auto-rejected: nobody approved this team launch within ${Math.round(waitedMs / 60_000)} minutes. `
    + 'Do not retry the launch. Finish the task yourself with the tools you already have, '
    + 'and state in your final report that no team member was sent because nobody approved in time.';
}

export interface SwarmLaunchApprovalResult {
  approved: boolean;
  feedback?: string;
  autoApproved: boolean;
  request: SwarmLaunchRequest;
}

export class SwarmLaunchApprovalGate {
  private requests = new Map<string, SwarmLaunchRequest>();
  private counter = 0;
  /** Resolvers for in-flight waitForDecision promises (event-driven wake-up) */
  private pendingResolvers = new Map<string, (result: SwarmLaunchApprovalResult) => void>();
  /**
   * 持久化仓库（ADR-010 #2）。null 表示 DB 未就绪 / 测试不需要持久化。
   */
  private persistRepo: PendingApprovalRepository | null = null;
  /**
   * 无人值守会话的等待：requestId → 到期自动拒计时器。任何结算路径都要经
   * settleUnattendedWait 清计时器并撤回通知。
   */
  private unattendedWaits = new Map<string, ReturnType<typeof setTimeout>>();
  /** 已经发出需要授权通知的等待；结算时只撤回真发过的。 */
  private notifiedWaits = new Set<string>();

  /** 兼容旧调用方；超时自动拒/批已退役，options 忽略。 */
  constructor(_options?: { approvalTimeoutMs?: number }) {}

  /**
   * 注入持久化 repo，并 hydrate 上次进程崩溃残留的 launch pending 行。
   * Durable Agent Team 的 approval identity 跨 attempt 稳定；重启只能恢复
   * 同一 pending request，不能把它改写成 rejected 或重新发起第二个 approval。
   * resolver 由后续全局 recovery dispatch 注册，本层只恢复可见投影。
   */
  attachPersistence(repo: PendingApprovalRepository, _now: number = Date.now()): number {
    this.persistRepo = repo;
    let hydrated = 0;
    try {
      const pending = repo.listByKindAndStatus('launch', 'pending');
      for (const row of pending) {
        if (row.kind !== 'launch') continue;
        try {
          const request = JSON.parse(row.payloadJson) as SwarmLaunchRequest;
          request.status = 'pending';
          this.requests.set(request.id, request);
          hydrated += 1;
        } catch (err) {
          logger.warn(`Failed to hydrate orphaned launch ${row.id}`, err);
        }
      }
      if (hydrated > 0) {
        logger.warn(`Hydrated ${hydrated} waiting swarm launch approval(s) from previous process`);
      }
    } catch (err) {
      logger.error('attachPersistence: failed to hydrate orphaned launches', err);
    }
    return hydrated;
  }

  private safePersistInsert(request: SwarmLaunchRequest): void {
    if (!this.persistRepo) return;
    try {
      this.persistRepo.insert({
        id: request.id,
        kind: 'launch',
        agentId: null,
        agentName: null,
        coordinatorId: null,
        payload: request,
        submittedAt: request.requestedAt,
      });
    } catch (err) {
      logger.warn(`PendingApproval insert failed for ${request.id}`, err);
    }
  }

  private safePersistResolve(
    id: string,
    status: 'approved' | 'rejected',
    feedback: string | null,
    resolvedAt: number,
  ): void {
    if (!this.persistRepo) return;
    try {
      this.persistRepo.resolve({ id, status, feedback, resolvedAt });
    } catch (err) {
      logger.warn(`PendingApproval resolve failed for ${id}`, err);
    }
  }

  async requestApproval(params: {
    tasks: SwarmLaunchTaskPreview[];
    summary?: string;
    scope: SwarmRunScope;
    requestId?: string;
  }): Promise<SwarmLaunchApprovalResult> {
    return withApprovalTrace('agent_team_launch', () => this.requestApprovalInternal(params), params.scope.sessionId);
  }

  private autoApproveResult(
    request: SwarmLaunchRequest,
    feedback: string,
  ): SwarmLaunchApprovalResult {
    request.status = 'approved';
    request.feedback = feedback;
    request.resolvedAt = Date.now();
    logger.info(`Swarm launch auto-approved: ${request.id} (${feedback})`);
    return {
      approved: true,
      feedback,
      autoApproved: true,
      request: { ...request, tasks: request.tasks.map((task) => ({ ...task })) },
    };
  }

  private async requestApprovalInternal(params: {
    tasks: SwarmLaunchTaskPreview[];
    summary?: string;
    scope: SwarmRunScope;
    requestId?: string;
  }): Promise<SwarmLaunchApprovalResult> {
    const request = this.createRequest(params.tasks, params.scope, params.summary, params.requestId);

    // 1) headless：无 renderer 立即批
    if (AppWindow.getAllWindows().length === 0) {
      logger.info(`No renderer available, auto-approving launch ${request.id}`);
      return this.autoApproveResult(request, 'Auto-approved (headless mode)');
    }

    // 2) 全只读成员：任何权限档立即批（不再干等 120s）
    if (request.writeAgentCount === 0) {
      return this.autoApproveResult(request, 'Auto-approved (read-only agents)');
    }

    // 3) 会话档「替我审批 / 完全访问」：写成员也免批
    // 档位以请求时刻为准（getModeForSession 含会话覆盖与钳制）
    const permissionMode = getPermissionModeManager().getModeForSession(params.scope.sessionId);
    if (permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions') {
      return this.autoApproveResult(
        request,
        `Auto-approved (session permission mode: ${permissionMode})`,
      );
    }

    // 4) 其余档：进等待；交互会话无超时自动拒/批，仅 approve/reject/cancel* 结算。
    //    无人值守会话额外停车进收件箱并设到期自动拒（parkUnattendedWait）。
    this.requests.set(request.id, request);
    this.safePersistInsert(request);
    getSwarmEventEmitter().launchRequested(request);

    logger.info(`Swarm launch requested: ${request.id} (${request.agentCount} agents, mode=${permissionMode})`);
    this.parkUnattendedWait(request);
    const releaseHold = holdStallClock(params.scope.sessionId);
    return this.waitForDecision(request.id).finally(releaseHold);
  }

  /**
   * 无人值守会话没人看会话卡：通知用户去收件箱，并给等待设期限（cron/heartbeat 30 分钟，
   * channel 等其余无人值守来源 24h）。到期只拒这一次启动，run 继续跑完并在结果里点名。
   * 交互会话直接返回：不通知、不计时。
   */
  private parkUnattendedWait(request: SwarmLaunchRequest): void {
    const modes = getPermissionModeManager();
    if (!modes.isUnattendedSession(request.sessionId)) return;
    const timeoutMs = modes.isUnattendedApprovalDegrade(request.sessionId)
      ? INTERACTION_TIMEOUTS.UNATTENDED_PARKED_APPROVAL_DEGRADE
      : INTERACTION_TIMEOUTS.PARKED_APPROVAL;
    // 同一 approval id 可被 durable 重试再次发起：旧计时器不能留着去拒新的这一次。
    const previous = this.unattendedWaits.get(request.id);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => this.expireUnattendedWait(request.id, timeoutMs), timeoutMs);
    timer.unref?.();
    this.unattendedWaits.set(request.id, timer);
    logger.info(`Swarm launch parked for unattended session: ${request.id} (session=${request.sessionId}, expires in ${Math.round(timeoutMs / 60_000)} min)`);
    void this.notifyParked(request, timer);
  }

  /**
   * 通知服务按需加载：它的模块图很重（配置 / 鉴权 / 数据库），不该压在每个只想发起
   * 团队启动的调用方身上。加载是异步的，所以发之前要确认这一次等待还没结算。
   */
  private async notifyParked(request: SwarmLaunchRequest, timer: ReturnType<typeof setTimeout>): Promise<void> {
    try {
      const [{ notificationService }, { buildApprovalNotification }] = await Promise.all([
        import('../services/infra/notificationService'),
        import('../services/infra/approvalNotification'),
      ]);
      if (this.unattendedWaits.get(request.id) !== timer) return;
      this.notifiedWaits.add(request.id);
      notificationService.notifyNeedsInput({
        sessionId: request.sessionId,
        ...buildApprovalNotification(undefined, 'parked', request.sessionId),
        dedupeKey: request.id,
      });
    } catch (err) {
      logger.warn(`Swarm launch park notification failed: ${request.id}`, err);
    }
  }

  private expireUnattendedWait(requestId: string, waitedMs: number): void {
    const request = this.requests.get(requestId);
    if (!this.reject(requestId, buildLaunchExpiryFeedback(waitedMs))) {
      this.settleUnattendedWait(requestId);
      return;
    }
    if (request) {
      // Only the denial list: the run still completes. Never noteUnattendedApprovalTimeout here —
      // that code is a permanent cron failure and would disable the job.
      noteUnattendedApprovalDenial(request.sessionId, {
        tool: LAUNCH_APPROVAL_TOOL,
        requestedAt: request.requestedAt,
        code: TEAM_LAUNCH_APPROVAL_EXPIRED,
      });
    }
    logger.warn(`Swarm launch expired unanswered, auto-rejected: ${requestId} (session=${request?.sessionId ?? 'unknown'}, waited ${Math.round(waitedMs / 60_000)} min)`);
  }

  /** Every settlement path: stop the expiry timer and withdraw the needs-input notification. */
  private settleUnattendedWait(requestId: string): void {
    const timer = this.unattendedWaits.get(requestId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.unattendedWaits.delete(requestId);
    if (!this.notifiedWaits.delete(requestId)) return;
    void import('../services/infra/notificationService')
      .then(({ notificationService }) => notificationService.retractNeedsInput(requestId))
      .catch((err: unknown) => logger.warn(`Swarm launch notification retract failed: ${requestId}`, err));
  }

  approve(requestId: string, feedback?: string, expectedScope?: SwarmRunRef): boolean {
    const request = this.requests.get(requestId);
    if (request?.status !== 'pending') return false;
    if (expectedScope && (request.sessionId !== expectedScope.sessionId || request.runId !== expectedScope.runId)) return false;

    request.status = 'approved';
    request.feedback = feedback;
    request.resolvedAt = Date.now();
    this.settleUnattendedWait(requestId);
    this.safePersistResolve(requestId, 'approved', feedback ?? null, request.resolvedAt);
    getSwarmEventEmitter().launchApproved({ ...request });
    logger.info(`Swarm launch approved: ${requestId}`);

    // Event-driven wake-up
    const resolver = this.pendingResolvers.get(requestId);
    if (resolver) {
      this.pendingResolvers.delete(requestId);
      resolver({
        approved: true,
        feedback,
        autoApproved: false,
        request: { ...request, tasks: request.tasks.map((task) => ({ ...task })) },
      });
    }
    return true;
  }

  reject(requestId: string, feedback: string, expectedScope?: SwarmRunRef): boolean {
    const request = this.requests.get(requestId);
    if (request?.status !== 'pending') return false;
    if (expectedScope && (request.sessionId !== expectedScope.sessionId || request.runId !== expectedScope.runId)) return false;

    request.status = 'rejected';
    request.feedback = feedback;
    request.resolvedAt = Date.now();
    this.settleUnattendedWait(requestId);
    this.safePersistResolve(requestId, 'rejected', feedback, request.resolvedAt);
    getSwarmEventEmitter().launchRejected({ ...request });
    logger.info(`Swarm launch rejected: ${requestId}`);

    const resolver = this.pendingResolvers.get(requestId);
    if (resolver) {
      this.pendingResolvers.delete(requestId);
      resolver({
        approved: false,
        feedback,
        autoApproved: false,
        request: { ...request, tasks: request.tasks.map((task) => ({ ...task })) },
      });
    }
    return true;
  }

  /**
   * Cancel all pending launch approvals with a common reason.
   * ADR-010 #6：swarm 取消或进程 shutdown 时排干 pendingResolvers。
   * 返回被取消的 request 数量。
   */
  cancelAll(reason: string): number {
    if (this.pendingResolvers.size === 0) return 0;
    const feedback = `Cancelled: ${reason}`;
    let cancelled = 0;
    const now = Date.now();
    const entries = Array.from(this.pendingResolvers.entries());
    this.pendingResolvers.clear();
    for (const [requestId, resolver] of entries) {
      this.settleUnattendedWait(requestId);
      const request = this.requests.get(requestId);
      if (request?.status === 'pending') {
        request.status = 'rejected';
        request.feedback = feedback;
        request.resolvedAt = now;
        getSwarmEventEmitter().launchRejected({ ...request });
      }
      this.safePersistResolve(requestId, 'rejected', feedback, now);
      try {
        resolver({
          approved: false,
          feedback,
          autoApproved: true,
          request: request
            ? { ...request, tasks: request.tasks.map((task) => ({ ...task })) }
            : {
                id: requestId,
                sessionId: '__unknown__',
                runId: '__unknown__',
                treeId: '__unknown__',
                status: 'rejected',
                requestedAt: 0,
                summary: '',
                agentCount: 0,
                dependencyCount: 0,
                writeAgentCount: 0,
                tasks: [],
              },
        });
        cancelled += 1;
      } catch (err) {
        logger.warn(`Failed to resolve cancelled launch ${requestId}`, err);
      }
    }
    logger.info(`Cancelled ${cancelled} pending swarm launch approvals (${reason})`);
    return cancelled;
  }

  cancelRun(scope: SwarmRunRef, reason: string): number {
    const feedback = `Cancelled: ${reason}`;
    const now = Date.now();
    let cancelled = 0;

    for (const [requestId, resolver] of Array.from(this.pendingResolvers.entries())) {
      const request = this.requests.get(requestId);
      if (request?.sessionId !== scope.sessionId || request.runId !== scope.runId) continue;

      this.pendingResolvers.delete(requestId);
      this.settleUnattendedWait(requestId);
      request.status = 'rejected';
      request.feedback = feedback;
      request.resolvedAt = now;
      this.safePersistResolve(requestId, 'rejected', feedback, now);
      getSwarmEventEmitter().launchRejected({ ...request });
      resolver({
        approved: false,
        feedback,
        autoApproved: true,
        request: { ...request, tasks: request.tasks.map((task) => ({ ...task })) },
      });
      cancelled += 1;
    }

    return cancelled;
  }

  /** Session cancellation drains current launches without poisoning future runs. */
  cancelSession(sessionId: string, reason: string): number {
    const feedback = `Cancelled: ${reason}`;
    const now = Date.now();
    let cancelled = 0;

    for (const [requestId, resolver] of Array.from(this.pendingResolvers.entries())) {
      const request = this.requests.get(requestId);
      if (request?.sessionId !== sessionId) continue;

      this.pendingResolvers.delete(requestId);
      this.settleUnattendedWait(requestId);
      request.status = 'rejected';
      request.feedback = feedback;
      request.resolvedAt = now;
      this.safePersistResolve(requestId, 'rejected', feedback, now);
      getSwarmEventEmitter().launchRejected({ ...request });
      resolver({
        approved: false,
        feedback,
        autoApproved: true,
        request: { ...request, tasks: request.tasks.map((task) => ({ ...task })) },
      });
      cancelled += 1;
    }

    return cancelled;
  }

  getPendingResolverCount(): number {
    return this.pendingResolvers.size;
  }

  /**
   * 这条审批此刻是否还有人在等结果。重启后载回的 pending 行为 false：对它 approve/reject
   * 只会改状态、唤不醒任何人，所以收件箱和应答投递都以它为准，不把死行当成可处理的待办。
   */
  hasLiveWaiter(requestId: string): boolean {
    return this.pendingResolvers.has(requestId);
  }

  getRequest(requestId: string, expectedScope?: SwarmRunRef): SwarmLaunchRequest | undefined {
    const request = this.requests.get(requestId);
    if (request && expectedScope && !this.matchesScope(request, expectedScope)) return undefined;
    return request ? { ...request, tasks: request.tasks.map((task) => ({ ...task })) } : undefined;
  }

  getPendingRequests(scope?: SwarmRunRef): SwarmLaunchRequest[] {
    return Array.from(this.requests.values())
      .filter((request) => request.status === 'pending')
      .filter((request) => !scope || this.matchesScope(request, scope))
      .map((request) => ({
        ...request,
        tasks: request.tasks.map((task) => ({ ...task })),
      }));
  }

  private createRequest(
    tasks: SwarmLaunchTaskPreview[],
    scope: SwarmRunScope,
    summary?: string,
    requestId?: string,
  ): SwarmLaunchRequest {
    const requestedAt = Date.now();
    return {
      id: requestId ?? `launch_${getSwarmRunScopeKey(scope)}_${++this.counter}_${requestedAt}`,
      ...scope,
      status: 'pending',
      requestedAt,
      summary: summary || `准备并行启动 ${tasks.length} 个 agent`,
      agentCount: tasks.length,
      dependencyCount: tasks.reduce((total, task) => total + (task.dependsOn?.length || 0), 0),
      writeAgentCount: tasks.filter((task) => task.writeAccess).length,
      tasks: tasks.map((task) => ({ ...task })),
    };
  }

  private matchesScope(request: SwarmLaunchRequest, scope: SwarmRunRef): boolean {
    return request.sessionId === scope.sessionId && request.runId === scope.runId;
  }

  /** 等待用户 approve/reject 或 cancel*；无超时自动结算。 */
  private waitForDecision(requestId: string): Promise<SwarmLaunchApprovalResult> {
    return new Promise<SwarmLaunchApprovalResult>((resolve) => {
      this.pendingResolvers.set(requestId, resolve);
    });
  }
}

let gateInstance: SwarmLaunchApprovalGate | null = null;

export function getSwarmLaunchApprovalGate(): SwarmLaunchApprovalGate {
  if (!gateInstance) {
    gateInstance = new SwarmLaunchApprovalGate();
  }
  return gateInstance;
}
