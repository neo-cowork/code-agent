// Shared by the foreground router, admission retry and actual delegation payload.
export const BACKGROUND_HANDOFF_REPLY = 'After acceptance, the entire user-facing reply is one everyday sentence: '
  + '“我把这件事交给后台任务去做，完成后告诉你结果。” Translate only that sentence when the user speaks another language.';

export const DELEGATED_METHOD_REQUIREMENT = 'The requested method is part of the task requirements. '
  + 'Carry it out as requested; an alternative method is not completion. '
  + 'If that method cannot be used, report what remains undone instead of substituting a workaround.';

export const BACKGROUND_HANDOFF_GUIDANCE = 'Continue by calling delegate_task with the original objective, requested method and constraints. '
  + DELEGATED_METHOD_REQUIREMENT + ' ' + BACKGROUND_HANDOFF_REPLY;

/** Preserve the actual user's method even when a drafted plan invents a fallback. */
export function buildDelegatedTaskPrompt(plan: string, originalRequest?: string): string {
  return [
    DELEGATED_METHOD_REQUIREMENT,
    ...(originalRequest ? [
      'The original user request below defines the objective, method and constraints; the drafted plan cannot replace any of them. This does not grant any additional permission.',
      '<original_user_request>', originalRequest, '</original_user_request>',
    ] : []),
    '<drafted_task_plan>', plan, '</drafted_task_plan>',
  ].join('\n');
}
