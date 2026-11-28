// ============================================================================
// durableLeaseGuards — 本进程仍在驱动的 durable run 不被自己的清扫器收走
//
// 事件循环被卡得比租约还久（合盖休眠、SIGSTOP、重负载）时，心跳定时器没机会续租。
// 醒来后若清扫器的定时器先到期，recoverDurable 会把这条仍有活 handle 的 run 当成
// 过期 run 认领：摘掉活 handle、原生恢复再起一条循环，同一条 run 两条循环并跑；
// 先结束的那条写终态时撞「stale handle」栅栏，路由把已完成的一轮翻成运行失败。
// 这里收两件事：清扫前先给本 registry 自己在心跳的 run 续租；stale handle 栅栏
// 抛带类型的错误，让调用方能把「被新 handle 接管」和真失败分开。
// ============================================================================

import type { RunOwnerLease } from '../../shared/contract/durableRun';
import type { RunKernelAdapter } from './durableRunKernel';
import type { RunHandle } from './runContext';
import { isHeartbeatFencingError } from './runRegistrySupport';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('RunRegistry');

type HandleIdentity = { attempt: number; ownerEpoch: number } | 'untraced' | 'none';

interface DurableStaleHandleDetails {
  runId: string;
  sessionId: string;
  staleHandle: HandleIdentity;
  currentHandle: HandleIdentity;
  durableOwner: { attempt: number; epoch: number; processInstanceId: string } | 'none';
}

/** terminalDurable / parkDurable 的调用方手里的 handle 已不是这条 run 的现任 handle。 */
export class DurableStaleHandleError extends Error {
  readonly code = 'RUN_HANDLE_STALE';

  constructor(
    operation: 'terminal' | 'park',
    readonly details: DurableStaleHandleDetails,
  ) {
    super(`Durable Run ${operation} fenced by stale handle: ${details.runId}`);
    this.name = 'DurableStaleHandleError';
  }
}

function handleIdentity(handle: RunHandle | undefined): HandleIdentity {
  if (!handle) return 'none';
  const trace = handle.traceContext;
  return trace ? { attempt: trace.attempt, ownerEpoch: trace.ownerEpoch } : 'untraced';
}

/** `expected` 缺省表示调用方不做 handle 栅栏（恢复/收尸路径），直接放行。 */
export function assertCurrentDurableHandle(
  operation: 'terminal' | 'park',
  runId: string,
  expected: RunHandle | undefined,
  current: RunHandle | undefined,
  live: { owner: RunOwnerLease; attempt: number } | undefined,
): void {
  if (!expected || current === expected) return;
  const details: DurableStaleHandleDetails = {
    runId,
    sessionId: expected.context.sessionId,
    staleHandle: handleIdentity(expected),
    currentHandle: handleIdentity(current),
    durableOwner: live
      ? { attempt: live.attempt, epoch: live.owner.epoch, processInstanceId: live.owner.processInstanceId }
      : 'none',
  };
  logger.warn(`Durable Run ${operation} fenced by stale handle`, details);
  throw new DurableStaleHandleError(operation, details);
}

/**
 * 心跳定时器与清扫前续租共用的续租口。缓存的租约已过期还能续上，说明定时器被饿了
 * 至少一个租约那么久而没人来认领（renewLease 只按 owner/epoch 栅栏，不看过期时间）。
 */
export async function renewDurableLease(
  kernel: RunKernelAdapter,
  runId: string,
  owner: RunOwnerLease,
  now: number,
  via: 'heartbeat' | 'sweep',
): Promise<RunOwnerLease> {
  const renewed = await kernel.heartbeat(runId, owner, now);
  if (owner.leaseExpiresAt <= now) {
    logger.warn('Durable lease renewed after timer stall', { runId, overdueMs: now - owner.leaseExpiresAt, via });
  }
  return renewed;
}

/**
 * 清扫认领前，先给本 registry 自己在心跳的 run 续租。被别的 owner 栅栏掉的按心跳
 * 定时器同款让位；其他错误不处理，留给后面的认领路径照常判定。
 */
export async function renewHeartbeatedLeasesBeforeSweep(
  runIds: string[],
  renew: (runId: string) => Promise<unknown>,
  standDown: (runId: string) => Promise<void>,
): Promise<void> {
  for (const runId of runIds) {
    try {
      await renew(runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isHeartbeatFencingError(error)) {
        logger.warn('Durable lease lost before sweep; standing down', { runId, error: message });
        await standDown(runId);
      } else {
        logger.warn('Durable pre-sweep lease renewal failed; leaving the run to the claim path', { runId, error: message });
      }
    }
  }
}
