import { AgentFailureCode } from '@shared/contract/agentFailure';

// Exact host diagnostics from agentTreeService. They are keys, never display copy.
export const agentFailureHostPhrases: Record<string, AgentFailureCode> = {
  '上级角色规则不允许它继续': AgentFailureCode.BlockedByParentRole,
  '需要的权限没有通过': AgentFailureCode.PermissionDenied,
  '需要的能力当前不可用': AgentFailureCode.ToolUnavailable,
  '助手设置的等待时间超过了允许的上限，需要缩短': AgentFailureCode.InvalidArguments,
  '可用预算已经用完': AgentFailureCode.BudgetExhausted,
  '处理时间超过了限制': AgentFailureCode.Timeout,
  '父任务已经结束': AgentFailureCode.ParentGone,
  '用户取消了这个任务': AgentFailureCode.CancelledByUser,
  '父任务取消了这个任务': AgentFailureCode.CancelledByParent,
  '依赖的任务失败了': AgentFailureCode.DependencyFailed,
  '依赖的任务不存在': AgentFailureCode.DependencyMissing,
  '工作流中的一个阶段失败了': AgentFailureCode.WorkflowStageFailed,
  '无法创建隔离工作区': AgentFailureCode.WorktreeCreateFailed,
  '模型调用没有成功完成': AgentFailureCode.ModelError,
  '失败原因还不明确': AgentFailureCode.Unknown,
};
