// 审批卡「你让我做的」引述（N-APPROVAL-CARD-USER-QUOTE）。

/** 审批卡引述用户原话的最大字符数；超出截断并带 truncated 标记，渲染层补省略号。 */
export const APPROVAL_USER_REQUEST_MAX_CHARS = 160;

/** 取最近多少条消息找「最后一条用户原话」。 */
export const APPROVAL_USER_REQUEST_LOOKBACK_MESSAGES = 50;
