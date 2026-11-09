// ============================================================================
// 后台子代理中途出错的白话原因（N-FIX-BROWSER-TASK-CONTEXT-BLOAT-SILENT-END）
// 原始异常文本多是英文/供应商报错，直接交给父模型转述用户看不懂；按已有失败码
// 映射成一句中文原因 + 下一步，原始文本仍保留在 logger / 诊断里。
// ============================================================================

import { AgentFailureCode } from '../../shared/contract/agentFailure';

const HAN_RE = /[㐀-䶿一-鿿]/u;

const REASON_BY_CODE: Partial<Record<AgentFailureCode, string>> = {
  [AgentFailureCode.Timeout]: '运行时间太长，被自动停止了',
  [AgentFailureCode.ModelError]: '模型服务暂时出错或请求太频繁',
  [AgentFailureCode.BudgetExhausted]: '本次任务的额度用完了',
  [AgentFailureCode.PermissionDenied]: '需要的操作没有获得许可',
  [AgentFailureCode.ToolUnavailable]: '需要用的功能当前不可用',
  [AgentFailureCode.ParentGone]: '发起它的对话已经结束',
};

/** 已经是中文的报错原样保留；英文/未知报错换成按失败码归类的白话原因。 */
export function describeSubagentStopReason(rawError: string, code: AgentFailureCode): string {
  const reason = HAN_RE.test(rawError)
    ? rawError.trim()
    : (REASON_BY_CODE[code] ?? '运行中遇到了意外错误');
  return `后台任务中途停止了：${reason}。你可以回复「继续」让它重试，已经看过的内容不会丢。`;
}
