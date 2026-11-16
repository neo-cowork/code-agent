// Exposure only: the user message always reaches the model unchanged.
// Shared by foreground tools, deferred preload and native-reminder exclusion.
const SCHEDULE_TASK_INTENT_RE = /定时任务|自动化任务|周期任务|一次性任务|每天|每日|每周|每星期|每月|每个工作日|工作日.{0,12}(?:点|时|执行)|自动(?:执行|运行|生成|导出|汇总|备份)|\b(?:scheduled?\s+(?:(?:a|an|the)\s+)?(?:(?:one[ -]time|recurring|automation)\s+)?tasks?|automation\s+tasks?|recurring|every\s+(?:day|week|month|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|weekly|monthly|automatically|auto[ -]run)\b/i;

export function isScheduleTaskChatIntent(text: string): boolean {
  return SCHEDULE_TASK_INTENT_RE.test(text);
}
