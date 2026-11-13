import { Cron } from 'croner';
import type { CanUseToolFn, ToolContext, ToolHandler, ToolModule, ToolResult } from '../../../protocol/tools';
import type { CreateCronJobDefinition } from '../../../../shared/contract/cron';
import { formatCronExpressionLabel } from '../../../../shared/cronHumanize';
import { getCronService } from '../../../cron/cronService';
import { getPermissionModeManager } from '../../../permissions/modes';
import { createScheduledTaskSchema as schema } from './createScheduledTask.schema';

class CreateScheduledTaskHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(args: Record<string, unknown>, ctx: ToolContext, canUseTool: CanUseToolFn): Promise<ToolResult<string>> {
    if (getPermissionModeManager().isUnattendedSession(ctx.sessionId)) {
      return { ok: false, code: 'UNATTENDED_UNSUPPORTED', error: 'Schedule creation requires an attended conversation and user confirmation.' };
    }
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    const cron = typeof args.cron === 'string' ? args.cron.trim() : '';
    const at = typeof args.at === 'string' ? args.at.trim() : '';
    if (!name || !prompt || Boolean(cron) === Boolean(at)) {
      return { ok: false, code: 'INVALID_ARGS', error: 'Provide name, prompt and exactly one of cron or at.' };
    }
    let definition: CreateCronJobDefinition;
    let when: string;
    try {
      const timezone = typeof args.timezone === 'string' ? args.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;
      new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
      if (cron) {
        if (cron.split(/\s+/).length !== 5) throw new Error('Use a five-field cron expression.');
        const timer = new Cron(cron, { timezone, paused: true });
        const next = timer.nextRun();
        timer.stop();
        if (!next) throw new Error('Schedule has no future occurrence.');
        definition = { name, enabled: true, runsOn: 'local', scheduleType: 'cron', schedule: { type: 'cron', expression: cron, timezone }, action: { type: 'agent', agentType: 'default', prompt } };
        when = `${formatCronExpressionLabel(cron, timezone, 'en')} (${timezone})`;
      } else {
        const timestamp = Date.parse(at);
        if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(at) || !Number.isFinite(timestamp) || timestamp <= Date.now()) {
          throw new Error('at must be a future ISO timestamp with an explicit UTC offset.');
        }
        definition = { name, enabled: true, runsOn: 'local', scheduleType: 'at', schedule: { type: 'at', datetime: timestamp }, action: { type: 'agent', agentType: 'default', prompt } };
        when = at;
      }
    } catch (error) {
      return { ok: false, code: 'INVALID_ARGS', error: String(error) };
    }
    const summary = `${name}\n${when}\n${prompt}`;
    const permit = await canUseTool(schema.name, args, summary, {
      sessionId: ctx.sessionId, forceConfirm: true, type: 'command', tool: schema.name,
      reason: summary, dangerLevel: 'normal',
      details: { preview: { type: 'generic', summary }, changes: summary },
    });
    if (!permit.allow) return { ok: false, code: 'PERMISSION_DENIED', error: 'User did not confirm schedule creation.' };
    if (ctx.abortSignal.aborted) return { ok: false, code: 'ABORTED', error: 'Schedule creation was cancelled.' };
    try {
      const job = await getCronService().createJob(definition);
      return { ok: true, output: `Created scheduled task: ${name}\n${when}\n${prompt}`, meta: { jobId: job.id } };
    } catch (error) {
      return { ok: false, code: 'SCHEDULE_CREATE_FAILED', error: String(error) };
    }
  }
}

export const createScheduledTaskModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler: () => new CreateScheduledTaskHandler(),
};
