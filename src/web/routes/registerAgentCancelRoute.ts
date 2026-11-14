import type { Router } from 'express';
import type { DurableRunReadService } from '../../host/app/durableRunReadService';
import type { RunRegistry } from '../../host/runtime/runRegistry';
import { CANCELLATION_TIMEOUTS } from '../../shared/constants';
import { getTaskManager } from '../../host/task/TaskManager';
import { AgentCancelBodySchema } from './agentBodySchemas';
import { isDurableTerminalNativeControl } from './agentDurableRouteLifecycle';

export async function waitForCancelSettlement(input: {
  runId: string;
  sessionId: string;
  runRegistry: RunRegistry;
  readService?: DurableRunReadService;
  timeoutMs: number;
  pollMs: number;
}): Promise<'settled' | 'timeout'> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (!input.runRegistry.get(input.runId)) {
      return 'settled';
    }
    if (input.readService) {
      const terminal = await isDurableTerminalNativeControl({
        readService: input.readService,
        runRegistry: input.runRegistry,
        runId: input.runId,
        sessionId: input.sessionId,
      });
      if (terminal) {
        return 'settled';
      }
    }
    await new Promise((resolve) => setTimeout(resolve, input.pollMs));
  }
  return input.runRegistry.get(input.runId) ? 'timeout' : 'settled';
}

export function registerAgentCancelRoute(
  router: Router,
  runRegistry: RunRegistry,
  getReadService?: () => DurableRunReadService | undefined,
  onRecoveredWaitingCancelled?: (input: { runId: string; sessionId: string }) => void,
): void {
  router.post('/cancel', async (req, res) => {
    const parsedBody = AgentCancelBodySchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      res.status(400).json({ error: 'Invalid cancel target', code: 'INVALID_PAYLOAD' });
      return;
    }
    const { runId, sessionId, abandonParked } = parsedBody.data;
    const target = runRegistry.resolve({ runId, sessionId });
    // Web 主链的前台 run 只在 RunRegistry，TaskManager 看不到它——会话的后台委派任务/子代理
    // 必须在这里同步发出 abort（idle 前台时 target 为空，也不能因此漏停后台）。
    const stopSessionId = target?.context.sessionId ?? sessionId;
    const backgroundSettled = stopSessionId
      ? getTaskManager().cancelSessionBackgroundWork(stopSessionId)
      : Promise.resolve();
    if (!target) {
      await backgroundSettled;
      // 恢复成 waiting 的 durable run 没有 handle，resolve() 查不到；不兜底的话
      // 路由只会回 "No active agent"，run 永远到不了终态，同一会话也起不了新 run。
      // user_stop 停靠除外：那是用户自己停出来的（保留「继续」），重复 Stop 对它是
      // no-op，只有显式「放弃」（abandonParked）才终态化。
      const recovered = await runRegistry.terminalRecoveredWaitingRun(
        { runId, sessionId },
        undefined,
        { abandonParked: abandonParked === true },
      );
      if (recovered) {
        if (!recovered.joined) onRecoveredWaitingCancelled?.({ runId: recovered.runId, sessionId: recovered.sessionId });
        res.json({ message: 'Cancelled', runId: recovered.runId, sessionId: recovered.sessionId });
        return;
      }
      if (await isDurableTerminalNativeControl({
        readService: getReadService?.(),
        runRegistry,
        runId,
        sessionId,
      })) {
        res.json({ message: 'No active agent to cancel' });
        return;
      }
      const ambiguous = !runId && !sessionId && runRegistry.size > 1;
      res.status(ambiguous ? 409 : 200).json({
        message: ambiguous
          ? 'runId or sessionId is required when multiple runs are active'
          : 'No active agent to cancel',
        ...(ambiguous ? { code: 'RUN_TARGET_REQUIRED' } : {}),
      });
      return;
    }

    await target.cancel('user');
    await backgroundSettled;

    // Honest response: only claim "Cancelled" after the run left the active set
    // (registry unregister) or durable facts report terminal. Primary consumer
    // (renderer cancel) optimistically clears UI on invoke success — waiting for
    // real settlement keeps that contract truthful. On timeout return
    // cancel_requested so callers can keep polling instead of being lied to.
    const settlement = await waitForCancelSettlement({
      runId: target.context.runId,
      sessionId: target.context.sessionId,
      runRegistry,
      readService: getReadService?.(),
      timeoutMs: CANCELLATION_TIMEOUTS.ROUTE_SETTLE_WAIT,
      pollMs: CANCELLATION_TIMEOUTS.ROUTE_SETTLE_POLL,
    });

    if (settlement === 'settled') {
      res.json({
        message: 'Cancelled',
        runId: target.context.runId,
        sessionId: target.context.sessionId,
      });
      return;
    }

    res.status(202).json({
      message: 'cancel_requested',
      code: 'CANCEL_REQUESTED',
      runId: target.context.runId,
      sessionId: target.context.sessionId,
    });
  });
}
