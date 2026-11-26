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
  [AgentFailureCode.StepCapReached]: '本次任务做到了步数上限，已停下',
  [AgentFailureCode.PermissionDenied]: '需要的操作没有获得许可',
  [AgentFailureCode.ToolUnavailable]: '需要用的功能当前不可用',
  [AgentFailureCode.ParentGone]: '发起它的对话已经结束',
  [AgentFailureCode.CancelledByUser]: '被取消了',
  [AgentFailureCode.CancelledByParent]: '被取消了',
};

const RETRYABLE_CODES: ReadonlySet<AgentFailureCode> = new Set([
  AgentFailureCode.Timeout,
  AgentFailureCode.ModelError,
  AgentFailureCode.Unknown,
]);

/** 已经是中文的报错原样保留；英文/未知报错换成按失败码归类的白话原因。 */
export function describeSubagentStopReason(rawError: string, code: AgentFailureCode): string {
  // 已经是中文的句子（步数用尽结论、取消说明等）本身就是给用户看的，原样放行不重复包装。
  if (HAN_RE.test(rawError) && !/\b(?:Error|Exception|provider|inference|HTTP|stack)\b/i.test(rawError)) return rawError.trim();
  const reason = REASON_BY_CODE[code] ?? '运行中遇到了意外错误';
  // 只有可能自行恢复的原因才建议重试；权限/额度/功能不可用/对话已结束重试必然再失败，不给这句误导。
  if (!RETRYABLE_CODES.has(code)) return `后台任务中途停止了：${reason}。`;
  return `后台任务中途停止了：${reason}。你可以回复「继续」让它重试，已经看过的内容不会丢。`;
}

export function agentFailureReasonText(code: AgentFailureCode): string {
  switch (code) {
    case AgentFailureCode.BlockedByParentRole:
      return '上级角色规则不允许它继续';
    case AgentFailureCode.PermissionDenied:
      return '需要的权限没有通过';
    case AgentFailureCode.ToolUnavailable:
      return '需要的能力当前不可用';
    case AgentFailureCode.InvalidArguments:
      return '助手设置的等待时间超过了允许的上限，需要缩短';
    case AgentFailureCode.BudgetExhausted:
      return '可用预算已经用完';
    case AgentFailureCode.StepCapReached:
      return '执行步数已达上限';
    case AgentFailureCode.Timeout:
      return '处理时间超过了限制';
    case AgentFailureCode.ParentGone:
      return '父任务已经结束';
    case AgentFailureCode.CancelledByUser:
      return '用户取消了这个任务';
    case AgentFailureCode.CancelledByParent:
      return '父任务取消了这个任务';
    case AgentFailureCode.DependencyFailed:
      return '依赖的任务失败了';
    case AgentFailureCode.DependencyMissing:
      return '依赖的任务不存在';
    case AgentFailureCode.WorkflowStageFailed:
      return '工作流中的一个阶段失败了';
    case AgentFailureCode.WorktreeCreateFailed:
      return '无法创建隔离工作区';
    case AgentFailureCode.ModelError:
      return '模型调用没有成功完成';
    case AgentFailureCode.Unknown:
    default:
      return '失败原因还不明确';
  }
}
