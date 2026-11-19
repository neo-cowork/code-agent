// ============================================================================
// 桌面声明闸门（desktopActionClaimGate）warn 档的用户可见前置提示（zh/en）
//
// 该文案会作为前缀写进最终 assistant 消息并持久化，属于用户可见文案：
// 不写内部工具名（Computer / computer_use 等）、不写内部状态术语，只用大白话
// 说明「本轮没有实际核实」。locale 由闸门拼装 warn 时用 getHostUiLocale() 选定
// （与 confirmationGate / foregroundShellDenial 同一机制）。
// 模型侧的修复提示（repair prompt）不在此文件：它不是用户可见文案，保持英文原样。
// ============================================================================
export const DESKTOP_CLAIM_GATE_WARNING: Record<'zh' | 'en', string> = {
  zh: '这段话里提到的桌面操作我这一轮还没有实际核实。',
  en: "I haven't actually verified the desktop actions mentioned below in this turn.",
};
