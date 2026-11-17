import type { ToolModule } from '../../../protocol/tools';
import { getPermissionModeManager } from '../../../permissions/modes';
import { getSessionManager } from '../../../services/infra/sessionManager';
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
      ctx.emit({ type: 'schedule_draft_requested', data: { sessionId: ctx.sessionId, description: args.description } });
      return {
        ok: true,
        output: 'The scheduled-task confirmation card has been requested in the conversation. Tell the user in their language that the draft card is ready and nothing is created until they confirm it. Do not claim the task exists or is already scheduled.',
      };
    },
  }),
};
