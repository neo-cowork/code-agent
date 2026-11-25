import { SCHEDULE_DRAFT_FAILURE } from '../../../../shared/constants/cronErrors';
import type { ToolModule } from '../../../protocol/tools';
import { getPermissionModeManager } from '../../../permissions/modes';
import { getSessionManager } from '../../../services/infra/sessionManager';
import { registerScheduleDraftRequest } from '../../../cron/scheduleDraftRequests';
import { scheduleTaskSchema } from './scheduleTask.schema';

export const scheduleTaskModule: ToolModule<Record<string, unknown>, string> = {
  schema: scheduleTaskSchema,
  createHandler: () => ({
    schema: scheduleTaskSchema,
    async execute(args, ctx) {
      const refuse = () => ({
        ok: false as const,
        code: 'ATTENDED_SESSION_REQUIRED',
        error: 'A scheduled-task draft needs a conversation the user personally attends. Ask them to open a conversation and request the draft there.',
      });
      if (ctx.neoTag || getPermissionModeManager().isUnattendedSession(ctx.sessionId)) return refuse();
      try {
        const session = await getSessionManager().getSession(ctx.sessionId, 1);
        if (!session || (session.origin && session.origin.kind !== 'manual' && session.origin.kind !== 'retry')) return refuse();
      } catch {
        return refuse();
      }
      if (typeof args.description !== 'string' || !args.description.trim()) {
        return { ok: false, code: 'INVALID_ARGS', error: 'description must include the user’s request: when to run and what to do.' };
      }
      if (ctx.abortSignal.aborted) return { ok: false, code: 'ABORTED', error: 'Draft request cancelled.' };
      const { request, result, cancel, replacedShownCard } = registerScheduleDraftRequest(ctx.sessionId, args.description, ctx.abortSignal);
      try {
        const { sessionId, requestId, description } = request;
        ctx.emit({ type: 'schedule_draft_requested', data: { sessionId, requestId, description } });
      } catch (error) {
        cancel();
        throw error;
      }
      const replaced = replacedShownCard ? ' The previous draft in this conversation was replaced by this request.' : '';
      switch (await result) {
        case 'shown':
          return {
            ok: true,
            output: 'The scheduled-task confirmation card was displayed above the conversation input. Ask the user in their language to review and confirm it there. Nothing is created without their confirmation.',
          };
        case 'generation_failed':
          return {
            ok: false, code: SCHEDULE_DRAFT_FAILURE.GENERATION, userMessage: SCHEDULE_DRAFT_FAILURE.GENERATION,
            error: `The scheduled-task draft could not be prepared. Tell the user in plain language that no task was created and there is no confirmation card for this request.${replaced} Keep the reply to these facts without guessing why it failed.`,
          };
        case 'not_shown':
          return {
            ok: false, code: SCHEDULE_DRAFT_FAILURE.NOT_SHOWN, userMessage: SCHEDULE_DRAFT_FAILURE.NOT_SHOWN,
            error: `The scheduled-task confirmation card could not be shown. Tell the user in plain language that the card could not be displayed and no task was created.${replaced} Keep the reply to these facts without guessing why it failed.`,
          };
        case 'aborted':
          return { ok: false, code: 'ABORTED', error: 'The draft request was cancelled. No task was created.' };
      }
    },
  }),
};
