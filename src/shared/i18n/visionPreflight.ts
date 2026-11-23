// ============================================================================
// 视觉预处理"已先读图"用户可见通知文案（zh/en）
// locale 由调用方经 readPreviewHealthLocale() 从 configService 的 ui.language 读入
// （与 previewHealth 同一机制）。文案不掺内部模型/Provider id。
// ============================================================================
const VISION_PREFLIGHT_NOTICE_MESSAGES = {
  zh: '已先读取图片内容，再继续回答。',
  en: 'Read the image first, then continued with your answer.',
} as const;

const VISION_TOOL_UNSUPPORTED_NOTICE_MESSAGES = {
  zh: '识图模型不能调用工具，这次回答只用文字完成。',
  en: "The image-reading model can't use tools, so this reply will be text only.",
} as const;

export function formatVisionPreflightNotice(locale: 'zh' | 'en'): string {
  return VISION_PREFLIGHT_NOTICE_MESSAGES[locale];
}

export function formatVisionToolUnsupportedNotice(locale: 'zh' | 'en'): string {
  return VISION_TOOL_UNSUPPORTED_NOTICE_MESSAGES[locale];
}
