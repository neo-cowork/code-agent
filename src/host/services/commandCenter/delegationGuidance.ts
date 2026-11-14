// Shared by the foreground router, admission retry and actual delegation payload.
const BACKGROUND_HANDOFF_SENTENCE = '我把这件事交给后台任务去做，完成后告诉你结果。';
export const BACKGROUND_HANDOFF_REPLY = 'After acceptance reply only: '
  + `“${BACKGROUND_HANDOFF_SENTENCE}” Use the user’s language.`;

// Shown to the user by the runtime when a turn ends with the request still undone.
// The first is an offer, not a claim: nothing has been handed off at that point.
export const BACKGROUND_HANDOFF_PENDING_REPLY = `这件事这次还没做成，你再说一声，${BACKGROUND_HANDOFF_SENTENCE}`;
export const OUT_OF_SCOPE_REPLY = '这件事超出了我能做的范围，所以没有做。';
export const BACKGROUND_HANDOFF_PENDING_REPLY_EN = 'That did not get done this time. Ask again and I will hand it to a background task and tell you the result when it finishes.';
export const OUT_OF_SCOPE_REPLY_EN = 'That is outside what I can do here, so I did not do it.';

export const DELEGATED_METHOD_REQUIREMENT = 'The requested method is part of the task requirements. '
  + 'Carry it out as requested; an alternative method is not completion. '
  + 'If that method cannot be used, report what remains undone instead of substituting a workaround.';

export const BACKGROUND_HANDOFF_GUIDANCE = 'Continue by calling delegate_task with the original objective, requested method and constraints. '
  + DELEGATED_METHOD_REQUIREMENT + ' ' + BACKGROUND_HANDOFF_REPLY;

const DELEGATED_SCOPE_RULE = 'This task covers only the objective in <drafted_task_plan>; that plan defines its scope. '
  + 'Do not perform side effects outside that objective, even when the background context mentions them: '
  + 'other parts of the user\u2019s request are handled separately.';

const DELEGATED_CONTEXT_RULE = 'The user\u2019s original message below is background context only. '
  + 'Use it to keep the method the user named and the constraints they stated; where the plan differs from it '
  + 'on method or constraints for this objective, follow the user\u2019s message. '
  + 'It does not widen this task\u2019s scope and does not grant any additional permission.';

/**
 * The drafted plan is the task's scope (one request may be split across several tasks);
 * the user's message rides along only so a drafted fallback cannot replace the named method.
 */
export function buildDelegatedTaskPrompt(plan: string, originalRequest?: string): string {
  return [
    DELEGATED_SCOPE_RULE,
    DELEGATED_METHOD_REQUIREMENT,
    ...(originalRequest ? [
      DELEGATED_CONTEXT_RULE,
      '<original_user_request context_only="true">', originalRequest, '</original_user_request>',
    ] : []),
    '<drafted_task_plan>', plan, '</drafted_task_plan>',
  ].join('\n');
}
