import type { RoleWakeResult, RoleWakeTrigger } from '../../../shared/contract/roleAssets';
import { getSessionAutomationService } from '../sessionAutomation';
import type { RecordAutomationEventInput } from '../sessionAutomation/sessionAutomationService';
import { createLogger } from '../infra/logger';

const logger = createLogger('RoleProactivity');

/** Every wake, including one without a source conversation, owns a visible run record. */
export async function withRoleWakeAutomation(input: {
  sessionId: string; roleId: string; trigger: RoleWakeTrigger; title: string;
  sourceSessionId?: string; handoffPrompt?: string;
}, run: () => Promise<RoleWakeResult>): Promise<RoleWakeResult> {
  const service = getSessionAutomationService();
  const automationId = `role_wake:${input.sessionId}`;
  const handoff = input.handoffPrompt ? {
    handoffPrompt: input.handoffPrompt,
    nextStage: { prompt: input.handoffPrompt, title: '角色唤醒后继续' },
  } : {};
  try {
    await service.recordCreated({
      id: automationId, sourceSessionId: input.sourceSessionId ?? null,
      type: 'role_wake', status: 'running', title: input.title,
      cadenceLabel: input.trigger === 'event' ? '任务完成后唤醒' : '定时醒来',
      sourceRefId: input.sessionId, resultSessionId: input.sessionId,
      config: { roleId: input.roleId, trigger: input.trigger, ...handoff },
    });
  } catch (error) {
    logger.warn('Role wake automation creation feedback failed', { sessionId: input.sessionId, error: String(error) });
  }
  const recordEvent = async (event: RecordAutomationEventInput) => {
    try {
      await service.recordEvent(event);
    } catch (error) {
      logger.warn('Role wake automation result feedback failed', { sessionId: input.sessionId, error: String(error) });
    }
  };
  try {
    const result = await run();
    const silent = result.decision === 'silence';
    const goalFailed = result.advanceGoalStatus === 'aborted';
    await recordEvent({
      automationId,
      event: silent ? 'skipped' : result.advanceGoalStatus === 'met' ? 'stage_ready' : 'completed',
      status: silent ? 'skipped' : goalFailed ? 'failed' : 'completed',
      recordStatus: silent ? 'skipped' : goalFailed ? 'failed' : 'completed',
      resultSessionId: input.sessionId,
      summary: silent ? '巡检无需行动。' : `[${result.decision}] ${result.summary || '角色醒来产出了新内容'}`,
      eventId: `${automationId}:${result.decision}:${result.advanceGoalStatus ?? 'none'}`,
      lastRunAt: Date.now(),
      configPatch: {
        decision: result.decision, advanceGoalStatus: result.advanceGoalStatus,
        ...(result.rationale ? { rationale: result.rationale } : {}),
        ...(result.evidence ? { evidence: result.evidence } : {}),
        ...(result.rationaleMissing !== undefined ? { rationaleMissing: result.rationaleMissing } : {}),
        ...handoff,
      },
    });
    return result;
  } catch (error) {
    await recordEvent({
      automationId, event: 'failed', status: 'failed', recordStatus: 'failed',
      resultSessionId: input.sessionId, error: String(error), lastRunAt: Date.now(),
    });
    throw error;
  }
}
