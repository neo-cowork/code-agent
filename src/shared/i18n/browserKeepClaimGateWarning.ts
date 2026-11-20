// ============================================================================
// 浏览器「保留结果页」声明闸门（browserKeepClaimGate）warn 档的用户可见前置提示（zh/en）
//
// 作为前缀写进最终 assistant 消息并持久化。后台子任务的最终文本会被主会话转述，
// 所以前缀必须自成一句、不依赖「下面/below」这类指代：转述后仍然读得通。
// 大白话、不写内部工具名。模型侧修复提示不在此文件，保持英文原样。
// ============================================================================
export const BROWSER_KEEP_CLAIM_GATE_WARNING: Record<'zh' | 'en', string> = {
  zh: '注意：浏览器窗口其实没有保留，可能已经关闭；需要的话可以重新打开这个页面。文中若说窗口还开着，以这条提示为准。',
  en: 'Note: the browser window was not actually kept and may already be closed; the page can be reopened if needed. If the text says the window is still open, go by this note.',
};
