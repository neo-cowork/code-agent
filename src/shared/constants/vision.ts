/** 视觉分析 / 截图处理配置 */
export const VISION_IMAGE = {
  /** 发给视觉模型的最长边上限 (px) — API 安全阈值，超过则等比降采样 */
  MAX_EDGE_PX: 1568,
  /**
   * 发给视觉模型的单图解码字节上限。挡两类事故：一是单图超 provider 请求体上限
   * （模型侧只能事后报 413/request_too_large，见 ImagePayloadExceededError），二是
   * 一张超大图把单次请求的 token 成本抬上天。超限直接拒绝，不降级发原始字节。
   */
  MAX_BYTES: 5 * 1024 * 1024,
  /** 拿不到 display info 时假设的 Retina backing scale。Phase 2 用实测值替换，此常量留作 fallback */
  FALLBACK_SCALE_FACTOR: 2,
  /** sharp 降采样核 */
  RESIZE_KERNEL: 'lanczos3' as const,
} as const;

/** computer_batch 批处理配置 */
export const COMPUTER_BATCH = {
  /** 子动作间默认延迟 (ms)。0 = 完全保留现有无延迟行为 */
  DEFAULT_SETTLE_MS: 0,
  /** settleMs 上限，防止模型写出爆炸性的延迟 */
  MAX_SETTLE_MS: 5_000,
} as const;

/** browser_action secretRef：只允许解析此前缀的环境变量；`<NAME>_ORIGINS` 为该密钥的站点白名单。 */
export const BROWSER_SECRET_ENV_PREFIX = 'CODE_AGENT_BROWSER_SECRET_';
export const BROWSER_SECRET_ORIGINS_SUFFIX = '_ORIGINS';

/** browser_action get_dom_snapshot 给模型看的紧凑文本预算（字符）。超出时截断并提示 offset 翻页。 */
export const BROWSER_SNAPSHOT = {
  /** 模型可见快照文本的字符上限（含头部、标题、元素行与溢出提示行） */
  MAX_CHARS: 8_000,
  /** 单个标题文本的字符上限 */
  HEADING_TEXT_MAX_CHARS: 80,
  /** 单行元素描述（text/ariaLabel/placeholder）的字符上限 */
  ELEMENT_LABEL_MAX_CHARS: 80,
  /** 头部 url 行的字符上限（data:/长 query 的 URL 会撑爆预算） */
  URL_MAX_CHARS: 300,
} as const;
