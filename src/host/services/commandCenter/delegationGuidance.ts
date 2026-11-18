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

// \u63aa\u8f9e\u7ea6\u675f\uff1a\u8fd9\u4e09\u6bb5\u662f\u53d1\u7ed9\u540e\u53f0\u6a21\u578b\u7684\u9759\u6001\u5b57\u8282\uff0c\u4e0d\u5f97\u542b\u4efb\u4f55\u5185\u7f6e\u6280\u80fd\u522b\u540d\u7684\u6574\u8bcd
// \uff08\u66fe\u56e0 "scope" \u547d\u4e2d task-brief-builder \u522b\u540d\uff0c\u6bcf\u4e2a\u540e\u53f0\u4efb\u52a1\u90fd\u88ab\u8bef\u6ce8\u5165\u8be5\u6280\u80fd\uff09\u3002
// \u5b88\u95e8\u6d4b\u8bd5\uff1atests/unit/services/skills/delegatedPromptSkillAliasGate.test.ts\u3002
const DELEGATED_SCOPE_RULE = 'This task covers only the objective in <drafted_task_plan>; that plan defines the boundary of this task. '
  + 'Do not perform side effects outside that objective, even when the background context mentions them: '
  + 'other parts of the user\u2019s request are handled separately.';

const DELEGATED_CONTEXT_RULE = 'The user\u2019s original message below is background context only. '
  + 'Use it to keep the method the user named and the constraints they stated; where the plan differs from it '
  + 'on method or constraints for this objective, follow the user\u2019s message. '
  + 'It does not widen what this task covers and does not grant any additional permission.';

/** 信封标记：出现在 run 的用户消息里即该消息由 buildDelegatedTaskPrompt 机器拼装（运行时据此收窄别名词判）。 */
export const DELEGATED_TASK_PLAN_TAG = '<drafted_task_plan>';

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
    DELEGATED_TASK_PLAN_TAG, plan, '</drafted_task_plan>',
  ].join('\n');
}
