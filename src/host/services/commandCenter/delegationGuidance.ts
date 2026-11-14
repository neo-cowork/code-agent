// Shared by the foreground router, admission retry and actual delegation payload.
const BACKGROUND_HANDOFF_SENTENCE = '我把这件事交给后台任务去做，完成后告诉你结果。';
export const BACKGROUND_HANDOFF_REPLY = 'After acceptance reply only: '
  + `“${BACKGROUND_HANDOFF_SENTENCE}” Use the user’s language.`;

// Shown to the user by the runtime when a turn ends with the request still undone.
// The first is an offer, not a claim: nothing has been handed off at that point.
export const BACKGROUND_HANDOFF_PENDING_REPLY = `这件事这次还没做成，你再说一声，${BACKGROUND_HANDOFF_SENTENCE}`;
export const OUT_OF_SCOPE_REPLY = '这件事超出了我能做的范围，所以没有做。';

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
