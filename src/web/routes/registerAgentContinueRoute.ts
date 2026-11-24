import { registerEnvResumeContinuer, type EnvResumeProbeFactory } from '../../host/runtime/envResumeWaiter';
import type { Router } from 'express';
import type { Message } from '../../shared/contract';
import type { TaskManager } from '../../host/task';
import { getTaskManager as getDefaultTaskManager } from '../../host/task/TaskManager';
import { continueParkedDurableRun } from '../../host/app/durableRunContinuation';
import type { RunRegistry } from '../../host/runtime/runRegistry';
import { registerQuotaWaitContinuer } from '../../host/runtime/quotaWaitTimer';
import { formatError } from '../helpers/utils';
import { createLogger } from '../../host/services/infra/logger';
import { AgentContinueBodySchema } from './agentBodySchemas';

const logger = createLogger('AgentContinueRoute');

export function registerAgentContinueRoute(
  router: Router,
  runRegistry: RunRegistry,
  getTaskManager: () => TaskManager = getDefaultTaskManager,
  getMessages?: (sessionId: string) => Promise<Message[]>,
  envProbe?: EnvResumeProbeFactory,
  onSettled?: (sessionId: string) => void,
): void {
  // 续跑真正跑完（resolve 且不是「已在续跑」）才抽排队消息，与正常 run 收线同口径；
  // 抛错说明可能另有 run 在跑，此时抽会撞 run 冲突白烧重试。
  const notifySettled = (sessionId: string, result: { alreadyContinuing?: boolean }): void => {
    if (!onSettled || result.alreadyContinuing) return;
    try {
      onSettled(sessionId);
    } catch (error) {
      logger.warn('[AgentContinueRoute] onSettled callback failed', { sessionId, reason: formatError(error) });
    }
  };
  registerQuotaWaitContinuer(async ({ sessionId }) => {
    const result = await continueParkedDurableRun({
      sessionId,
      runRegistry,
      taskManager: getTaskManager(),
      ...(getMessages ? { getMessages } : {}),
    });
    notifySettled(sessionId, result);
    return result;
  });
  registerEnvResumeContinuer(async ({ sessionId, runId }) => {
    const result = await continueParkedDurableRun({
      sessionId, expectedRunId: runId, runRegistry, taskManager: getTaskManager(),
      ...(getMessages ? { getMessages } : {}),
    });
    notifySettled(sessionId, result);
    return result;
  }, envProbe);
  router.post('/continue', async (req, res) => {
    const parsedBody = AgentContinueBodySchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      res.status(400).json({ success: false, error: { code: 'INVALID_PAYLOAD', message: 'Missing sessionId' } });
      return;
    }

    try {
      const result = await continueParkedDurableRun({
        sessionId: parsedBody.data.sessionId,
        runRegistry,
        taskManager: getTaskManager(),
        ...(getMessages ? { getMessages } : {}),
      });
      notifySettled(parsedBody.data.sessionId, result);
      res.json({ success: true, data: result });
    } catch (error) {
      const message = formatError(error);
      const status = message.includes('already continuing') || message.includes('already running')
        || message.includes('No parked durable run')
        ? 409
        : 500;
      res.status(status).json({
        success: false,
        error: { code: 'CONTINUE_FAILED', message },
      });
    }
  });
}
