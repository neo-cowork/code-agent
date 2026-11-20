// ============================================================================
// 浏览器「保留结果页」声明闸门（browserKeepClaimGate）warn 档的用户可见前置提示（zh/en）
//
// 作为前缀写进最终 assistant 消息并持久化：大白话、不写内部工具名。
// 模型侧的修复提示（repair prompt）不在此文件，保持英文原样。
// ============================================================================
export const BROWSER_KEEP_CLAIM_GATE_WARNING: Record<'zh' | 'en', string> = {
  zh: '下面说窗口还留着，但实际上这个窗口并没有保留，可能已经关闭了；需要的话我可以重新打开这个页面。',
  en: "The message below says the window is still open, but it was not actually kept and may already be closed. I can reopen the page if you need it.",
};
