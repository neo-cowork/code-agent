// 后台任务终态唤醒消息的识别：宿主注入的隐藏用户消息，正文是子任务结果，不是用户自己的请求。
// 判据必须只认唤醒消息本身，不能按 isMeta 一刀切（后台任务指令、改道、循环、计划执行也是 isMeta）。

export function backgroundWakePromptHead(shortName: string, outcome: '完成' | '失败'): string {
  return `后台任务 ${shortName} 已${outcome}，结果摘要：`;
}

const FOREGROUND_WAKE_PROMPT_RE = /^后台任务 [^\n]* 已(?:完成|失败)，结果摘要：/u;
const IDLE_WAKE_AUTOMATION_PREFIX = 'background-subagent:';

export function isBackgroundWakeMessage(message: {
  content?: unknown;
  metadata?: { automation?: { automationId?: string } } | null;
}): boolean {
  if (message.metadata?.automation?.automationId?.startsWith(IDLE_WAKE_AUTOMATION_PREFIX)) return true;
  return typeof message.content === 'string' && FOREGROUND_WAKE_PROMPT_RE.test(message.content);
}
