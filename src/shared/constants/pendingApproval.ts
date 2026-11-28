// 停车审批（pending_approvals）呈现常量（N-PARKED-APPROVAL-SURVIVE-RESTART-PERSIST）。
import { OUTBOUND_APPROVAL_DEGRADE_FEEDBACK } from '../i18n/outboundApprovalDegrade';

/**
 * 停车审批参数预览（argsPreview）脱敏后的截断上限。预览只要「一眼可辨这步要干什么」，
 * 完整入参不入库（库文件、收件箱渲染、SSE 事件三处都背着这份字符串，别放大）。
 */
export const PARKED_APPROVAL_PREVIEW_MAX_CHARS = 300;

/** 重启后被自动作废的停车审批，在自动化收件箱里保留这么久的灰色只读留痕（3 天）。 */
export const PARKED_APPROVAL_VOIDED_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

/** Model instructions after an unattended outbound approval expires. */
export const OUTBOUND_APPROVAL_DEGRADE = {
  saved: {
    code: 'OUTBOUND_DRAFT_SAVED',
    feedback: OUTBOUND_APPROVAL_DEGRADE_FEEDBACK.saved,
  },
  denied: {
    feedback: OUTBOUND_APPROVAL_DEGRADE_FEEDBACK.denied,
  },
} as const;

/** The tool call parked behind a team-launch approval (pending_approvals kind='launch'). */
export const LAUNCH_APPROVAL_TOOL = 'spawn_agent';
