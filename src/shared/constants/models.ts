import type { ModelProvider } from '../contract';
import catalog from '../model-catalog.json';
import { getContextWindow, normalizeModelId } from './defaults';

/** 模型配置 */
export const MODEL = {
  /** 默认 max_tokens — 与 MODEL_MAX_TOKENS.DEFAULT 保持一致 */
  DEFAULT_MAX_TOKENS: 16384,
  /** 默认 temperature */
  DEFAULT_TEMPERATURE: 0.7,
  /** 流式响应块大小 */
  STREAM_CHUNK_SIZE: 1024,
  /** 上下文窗口安全边际 */
  CONTEXT_SAFETY_MARGIN: 1000,
} as const;

/** 默认模型配置 */
export const DEFAULT_MODELS = {
  /** 主要对话模型 - LongCat 2.0（开放平台免费额度；2026-07-13 起替代 mimo：Token Plan key 失效） */
  chat: 'LongCat-2.0',
  /** 推理模型 - DeepSeek V4 Pro (按需付费，替代 R1) */
  reasoning: 'deepseek-v4-pro',
  /** 视觉理解模型 - 小米 MiMo Omni 包月（多模态，与 chat 同 provider，免费额度内）。
   *  原默认 glm-4.6v 与 ZHIPU_VISION_MODEL('glm-4.1v-thinking-flash') 不一致，且很多
   *  智谱套餐不含 glm-4.6v 导致截图分析 403；改用 xiaomi omni 与默认 provider 对齐。 */
  vision: 'mimo-v2-omni',
  /** 视觉快速模型（不支持 base64） */
  visionFast: 'glm-4.6v-flash',
  /** 代码模型 - LongCat 2.0（thinking + tool call，与 DEFAULT_PROVIDER 配对） */
  code: 'LongCat-2.0',
  /** 压缩/摘要模型 - Kimi K2.5 包月无成本 */
  compact: 'kimi-k2.5',
  /**
   * 快速判断模型 - 0ki GLM-5.3-flash（走 api.0ki.cn + ZHIPU_API_KEY）。
   * 不用 glm-4-flash：免费档走 bigmodel.cn + ZHIPU_OFFICIAL_API_KEY，该官方 key 已失效（401）。
   * 不可用 glm-4.7-flash：thinking 档，实测关思考也要 27-40s，短输出额度被 reasoning 吃光返回空。
   * 必须用非 thinking 的真·快模型：glm-5.3-flash 实测短分类 ~1.6s，满足 intent 分类 3s timeout。
   */
  quick: 'glm-5.3-flash',
  /** 长上下文模型（128k，与 DEFAULT_PROVIDER 配对；mimo 1M 档因 key 失效退役） */
  longContext: 'LongCat-2.0',
  /** 配额内免费模型 - LongCat 开放平台 */
  unlimited: 'LongCat-2.0',
} as const;

/**
 * 智谱官方端点（open.bigmodel.cn + ZHIPU_OFFICIAL_API_KEY）上的免费快模型。
 * DEFAULT_MODELS.quick 已切到 0ki 专属 glm-5.3-flash，官方端点上不存在该 id；
 * 写死官方端点的调用方（视频提示词扩写、语音粘贴）必须用这个，不能复用 DEFAULT_MODELS.quick。
 */
export const ZHIPU_OFFICIAL_QUICK_MODEL = 'glm-4-flash';

/**
 * 快模型鉴权失败拉黑窗口：某候选（provider+model+当前 key）401/403 后在此窗口内
 * 不再入选，解析自动降到下一级（fast → code → env 智谱）。换了 key 指纹即变、立即重试；
 * 窗口过后也会重试一次，避免上游误发 401 造成永久降级。
 */
export const QUICK_MODEL_AUTH_BLACKLIST_MS = 10 * 60_000;

/** Agent 子任务默认模型（包月无限制，适合高频调用） */
export const AGENT_DEFAULT_MODEL = {
  provider: 'moonshot',
  model: DEFAULT_MODELS.compact,
} as const;

/**
 * 模型能力档（B7 scaffold profile 数据源）：决定脚手架注入厚度。与
 * ModelDomainCapability（能力种类）和 hybrid ModelTier（子代理角色派发）语义不同，勿混用。
 * 未标注 = standard = 现状行为不变（fail-safe 默认）。
 */
export type ScaffoldTier = 'strong' | 'standard' | 'lite';

export interface ProviderModelEntry {
  id: string;
  label: string;
  group?: string; // optgroup label（同一 provider 内分组）
  desc?: string;
  /** 是否进入评测候选（默认 true）。false：搜索特化 / legacy / 视觉 / 中转重复等不该跑代码评测的模型 */
  evalEligible?: boolean;
  /** 模型能力档（缺省 = standard）。strong：旗舰 reasoning 档；lite：弱档（P0 仅数据标注） */
  scaffoldTier?: ScaffoldTier;
}

export interface ProviderInfo {
  id: ModelProvider;
  name: string;
  description: string;
  models: ProviderModelEntry[];
}

/**
 * 所有 Provider 及其可选模型 — Settings 页面的唯一数据源
 * 数据源: src/shared/model-catalog.json（项目内即真理源）
 * 直接编辑该 JSON 文件，不要走外部同步脚本
 */
const SUPPORTED_PROVIDERS = new Set<string>([
  'openai', 'claude', 'gemini', 'deepseek', 'zhipu',
  'qwen', 'moonshot', 'minimax', 'openrouter', 'perplexity',
  'longcat',    // LongCat API 开放平台
  'xiaomi',     // 小米 MiMo（Token Plan 包月）
  'custom',     // 自定义 OpenAI-compatible provider
  'local',      // Ollama 本地模型（toy provider + 评测 baseline）
  'volcengine', // 火山引擎 (豆包) — QUICK_SWITCH 已暴露但 SUPPORTED 漏加，被 provider-symmetry guardrail 抓出
  'grok',       // xAI Grok    — catalog 元数据齐备但未暴露至 SUPPORTED
]);

export const PROVIDER_MODELS: ProviderInfo[] = catalog.providers
  .filter((p) => SUPPORTED_PROVIDERS.has(p.id))
  .map((p) => ({
    id: p.id as ModelProvider,
    name: p.name,
    description: p.description,
    models: p.models.map((m) => ({
      id: m.id,
      label: m.label,
      ...('desc' in m && m.desc ? { desc: m.desc } : {}),
      ...('group' in m && m.group ? { group: m.group } : {}),
      ...('evalEligible' in m && m.evalEligible === false ? { evalEligible: false as const } : {}),
      ...('scaffoldTier' in m && m.scaffoldTier ? { scaffoldTier: m.scaffoldTier as ScaffoldTier } : {}),
    })),
  }));

/** 按 provider ID 快速查找 */
export const PROVIDER_MODELS_MAP: Record<string, ProviderInfo> = Object.fromEntries(
  PROVIDER_MODELS.map((p) => [p.id, p])
);

/**
 * Labels for runtime-only models that are real routing targets but intentionally
 * absent from the catalog so they do not become selectable provider rows.
 */
const RUNTIME_ONLY_MODEL_LABELS: Record<string, string> = {
  'glm-5.3': 'GLM-5.3',
  // 注册表（BASE + ADDITIONAL = host PROVIDER_REGISTRY 全量）里登记但刻意不进 catalog
  // 的模型（进 catalog 会变成设置页可选行）；标签取注册表 name，去掉末尾中文括号后缀
  // （半角 (…) / 全角 （…） 都去）。新增注册模型没补标签会被
  // tests/unit/shared/modelDisplayLabels.test.ts 钉红——那道门扫的是全量 patched 注册表。
  // minimax
  'abab6.5s-chat': 'abab6.5s',
  'abab6.5-chat': 'abab6.5',
  'abab5.5s-chat': 'abab5.5s',
  'abab5.5-chat': 'abab5.5',
  // gemini（直连侧未进 catalog 的档位）
  'gemini-3-pro': 'Gemini 3 Pro',
  'gemini-3-flash': 'Gemini 3 Flash',
  'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
  // volcengine
  'doubao-1.5-pro-256k': 'Doubao 1.5 Pro 256K',
  'doubao-1.5-thinking-pro': 'Doubao 1.5 Thinking Pro',
  'doubao-seed-1-6-vision-250815': 'Doubao Seed 1.6 Vision',
  // xiaomi
  'neohorse-1.5-flash-preview': 'NeoHorse 1.5 Flash',
  // openrouter（label 查表是精确匹配，带上游前缀的完整 id 就是运行时真源 id）
  'google/gemini-3-pro-preview': 'Gemini 3 Pro',
  'google/gemma-3n-e2b-it:free': 'Gemma 3',
  'anthropic/claude-opus-4.5': 'Claude Opus 4.5',
  'anthropic/claude-sonnet-4.5': 'Claude Sonnet 4.5',
  'anthropic/claude-haiku-4.5': 'Claude Haiku 4.5',
  'openai/gpt-5.2': 'GPT-5.2',
  'openai/gpt-5.2-codex': 'GPT-5.2 Codex',
  'meta-llama/llama-3.3-70b-instruct:free': 'Llama 3.3 70B',
  'meta-llama/llama-4-maverick': 'Llama 4 Maverick',
  'deepseek/deepseek-v3.2': 'DeepSeek V3.2',
  'deepseek/deepseek-r1-0528:free': 'DeepSeek R1',
  // BASE_PROVIDER_REGISTRY（基础注册表）里同样没进 catalog 的模型，标签规则同上。
  // deepseek
  'deepseek-coder': 'DeepSeek Coder',
  // claude（带日期后缀的正式 id）
  'claude-sonnet-4-20250514': 'Claude 4 Sonnet',
  'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
  'claude-3-5-haiku-20241022': 'Claude 3.5 Haiku',
  // openai
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o Mini',
  // groq（带上游前缀的完整 id 就是运行时真源 id，同 openrouter 按精确匹配查表）
  'meta-llama/llama-4-maverick-17b-128e-instruct': 'Llama 4 Maverick',
  'meta-llama/llama-4-scout-17b-16e-instruct': 'Llama 4 Scout',
  'openai/gpt-oss-20b': 'GPT OSS 20B',
  'llama-3.1-8b-instant': 'Llama 3.1 8B',
  'moonshotai/kimi-k2-instruct': 'Kimi K2',
  'groq/compound': 'Groq Compound',
  // local（Ollama 的 tag 形式 id，冒号是 id 的一部分）
  'qwen2.5-coder:7b': 'Qwen 2.5 Coder 7B',
  'qwen3:8b': 'Qwen3 8B',
  'qwen3:32b': 'Qwen3 32B',
  'gemma4:12b': 'Gemma4 12B',
  'gemma4:27b': 'Gemma4 27B',
  'deepseek-r1:7b': 'DeepSeek R1 7B',
  'deepseek-r1:32b': 'DeepSeek R1 32B',
  'llama4-scout:17b': 'Llama4 Scout 17B',
  'codestral:22b': 'Codestral 22B',
  // zhipu
  'codegeex-4': 'CodeGeeX-4',
  'cogview-3-flash': 'CogView-3 Flash',
  'cogvideox-flash': 'CogVideoX Flash',
  // qwen
  'qwen-max': 'Qwen Max',
  'qwen-plus': 'Qwen Plus',
  'qwen-turbo': 'Qwen Turbo',
  'qwq-plus': 'QwQ Plus',
  'qvq-max': 'QVQ Max',
  'qwen3-coder-plus': 'Qwen3 Coder Plus',
  'qwen3-coder-flash': 'Qwen3 Coder Flash',
  'qwen-coder-plus': 'Qwen Coder Plus',
  'qwen3-vl-plus': 'Qwen3 VL Plus',
  'qwen3-vl-flash': 'Qwen3 VL Flash',
  'qwen-vl-ocr': 'Qwen VL OCR',
  'qwen-omni-turbo': 'Qwen Omni Turbo',
  'qwen3-omni-flash': 'Qwen3 Omni Flash',
  'qwen-image-max': 'Qwen Image Max',
  'qwen-image-edit-max': 'Qwen Image Edit',
  'qwen3-tts-flash': 'Qwen3 TTS Flash',
  'qwen3-asr-flash-realtime': 'Qwen3 ASR Flash',
  'qwen2.5-7b-instruct-1m': 'Qwen 2.5 7B 1M',
  'qwen-mt-turbo': 'Qwen MT Turbo',
  'text-embedding-v4': 'Text Embedding V4',
  // moonshot
  'moonshot-v1-8k': 'Moonshot V1 8K',
  'moonshot-v1-32k': 'Moonshot V1 32K',
  'moonshot-v1-128k': 'Moonshot V1 128K',
};

const MODEL_LABELS: Record<string, string> = {
  ...Object.fromEntries(
    PROVIDER_MODELS.flatMap((provider) =>
      provider.models.map((model) => [model.id, model.label] as const)
    )
  ),
  ...RUNTIME_ONLY_MODEL_LABELS,
};

/**
 * 未登记 id 的可读名回落：按 `-`/`_` 切词、丢弃空段、每词首字母大写、空格连接。
 * my-custom-model-v2 → My Custom Model V2；空串 → 空串（保持原行为）。
 */
function readableModelIdFallback(modelId: string): string {
  return modelId
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function getModelDisplayLabel(modelId: string): string {
  return MODEL_LABELS[modelId] ?? readableModelIdFallback(modelId);
}

/** 模型 id → 能力档（catalog 标注的唯一消费入口，未标注 = standard） */
const MODEL_SCAFFOLD_TIERS: Record<string, ScaffoldTier> = Object.fromEntries(
  PROVIDER_MODELS.flatMap((provider) =>
    provider.models
      .filter((model) => model.scaffoldTier)
      .map((model) => [model.id, model.scaffoldTier as ScaffoldTier] as const)
  )
);

export function getModelScaffoldTier(modelId: string): ScaffoldTier {
  return MODEL_SCAFFOLD_TIERS[modelId] ?? 'standard';
}

/**
 * 已验证工具调用（agentic）的模型集合 —— 刻意保持小。
 *
 * 只认三种可追溯证据，别随意加第四种来源：
 *   ① 出厂默认模型（DEFAULT_MODELS 里跑主链路那几档 + AGENT_DEFAULT_MODEL）——产品自己天天在跑；
 *   ② catalog 标注 `scaffoldTier: 'strong'` 的旗舰档。
 *   ③ 带日期的真机工具调用验证清单；它只影响 UI 徽章，绝不借 scaffoldTier 改 agent 行为。
 *
 * 不在集合里 **不等于不能用**：只是「我们没验过，出问题自担风险」。UI 据此把未验证的
 * 折进「高级」并给风险提示，而不是禁用——非程序员配了不支持工具调用的模型时，
 * 至少知道崩在哪，而不是对着一个静默失败的对话发呆。
 *
 * 视觉/快判档（vision / visionFast / quick）刻意不进：它们跑的是看图和意图分类，
 * 不构成工具调用证据。
 */
export const VERIFIED_AGENTIC_MODELS: ReadonlySet<string> = new Set<string>([
  DEFAULT_MODELS.chat,
  DEFAULT_MODELS.code,
  DEFAULT_MODELS.compact,
  DEFAULT_MODELS.reasoning,
  DEFAULT_MODELS.longContext,
  DEFAULT_MODELS.unlimited,
  AGENT_DEFAULT_MODEL.model,
  ...Object.entries(MODEL_SCAFFOLD_TIERS)
    .filter(([, tier]) => tier === 'strong')
    .map(([modelId]) => modelId),
  // 2026-08-13 真机实测：官方 api.deepseek.com 3/3、基元 tokenrhythm 2/3 返回
  // get_weather({"city":"上海"}) 工具调用且 finish_reason=tool_calls；另 1 次 503 为中转可用性问题。
  // deepseek-flash（V4.1，2026-09-10）未做同款真机工具调用验证，不加进来。
  'deepseek-v4-flash',
  // 2026-08-13 真机实测（QE-02）：基元 tokenrhythm 0731 走 ModelRouter 真实入口（生产槽
  // config 形状，含 protocol:'openai' 印章）3/3 返回 get_weather 工具调用，日志证实
  // ResponsesProvider 路径（中转 /v1/responses），延迟 3.5/3.9/6.4s。
  'deepseek-v4-flash-0731',
]);

/** 该模型是否已验证工具调用。openrouter 那种带前缀的 id 走 normalizeModelId 再查一次。 */
export function isAgenticVerifiedModel(modelId: string): boolean {
  return VERIFIED_AGENTIC_MODELS.has(modelId) || VERIFIED_AGENTIC_MODELS.has(normalizeModelId(modelId));
}

/** 视觉模型能力详情 */
export const VISION_MODEL_CAPABILITIES: Record<string, {
  supportsBase64: boolean;
  supportsUrl: boolean;
  maxTokens: number;
  note: string;
}> = {
  'glm-4.6v': {
    supportsBase64: true,
    supportsUrl: true,
    maxTokens: 2048, // 实测限制
    note: '智谱视觉模型，支持 base64 和 URL',
  },
  'glm-4.6v-flash': {
    supportsBase64: false,
    supportsUrl: true,
    maxTokens: 1024, // 文档限制
    note: '智谱快速视觉模型，仅支持 URL',
  },
  'gpt-4o': {
    supportsBase64: true,
    supportsUrl: true,
    maxTokens: 4096,
    note: 'OpenAI 视觉模型',
  },
  // 'claude-3-5-sonnet-20241022' 已 EOL（2026-04-28 audit 清理）
} as const;

/**
 * 模型能力标签 — UI 显示 tool/vision/reasoning 标签的单一真理源。
 * 2026-04-28 audit 前散落于 ModelSwitcher.tsx，已迁移至此。
 */
export const MODEL_FEATURES: Record<string, ('tool' | 'vision' | 'reasoning')[]> = {
  // moonshot
  'kimi-k2.5': ['tool', 'reasoning'],
  'kimi-k2.6': ['tool', 'vision', 'reasoning'],
  'moonshot-v1-8k': ['tool'],
  'moonshot-v1-32k': ['tool'],
  'moonshot-v1-128k': ['tool'],
  // deepseek
  'deepseek-flash': ['tool', 'reasoning'],
  'deepseek-v4-flash': ['tool', 'reasoning'],
  'deepseek-v4-pro': ['tool', 'reasoning'],
  'deepseek-chat': ['tool'],
  'deepseek-coder': ['tool'],
  'deepseek-reasoner': ['reasoning'],
  // zhipu
  'glm-5': ['tool', 'reasoning'],
  'glm-5.1': ['tool', 'reasoning'],
  'glm-4.7': ['tool', 'reasoning'],
  'glm-4.7-flash': ['tool'],
  'glm-4.7-flashx': ['tool'],
  'glm-4-flash': ['tool'],
  'glm-5.3-flash': ['tool'],
  'glm-4.6v': ['vision', 'reasoning'],
  'glm-4.6v-flash': ['vision'],
  'codegeex-4': ['tool'],
  // openai
  'gpt-4o': ['tool', 'vision'],
  'gpt-4o-mini': ['tool', 'vision'],
  // claude
  'claude-opus-4-7': ['tool', 'vision', 'reasoning'],
  'claude-sonnet-4-6': ['tool', 'vision', 'reasoning'],
  'claude-haiku-4-5-20251001': ['tool', 'vision'],
  // volcengine
  'doubao-seed-1-6': ['tool', 'vision'],
  'doubao-seed-1-6-thinking': ['reasoning', 'vision'],
  'doubao-seed-1-6-flash': ['tool'],
  'doubao-seed-1-6-lite': ['tool'],
  // xiaomi MiMo（thinking-mode + tool calling）
  'neohorse-1.5-flash-preview': ['tool', 'vision'],
  'mimo-v2.6-flash': ['tool', 'vision', 'reasoning'],
  'mimo-v2.5-pro': ['tool', 'reasoning'],
  'mimo-v2.5': ['tool', 'reasoning'],
  'mimo-v2-pro': ['tool', 'reasoning'],
  'mimo-v2-omni': ['tool', 'vision', 'reasoning'],
  // LongCat
  'LongCat-2.0': ['tool', 'reasoning'],
  // local
  'qwen2.5-coder:7b': ['tool'],
  'qwen3:8b': ['tool'],
  'qwen3:32b': ['tool', 'reasoning'],
  'gemma4:12b': ['tool'],
  'gemma4:27b': ['tool', 'reasoning'],
  'deepseek-r1:7b': ['reasoning'],
  'deepseek-r1:32b': ['reasoning'],
  'llama4-scout:17b': ['tool', 'vision'],
  'codestral:22b': ['tool'],
};

/**
 * quick 车道「不能关思考」的推理模型 — 这些 id 发 reasoning_effort:'low' 控预算，不发 thinking:{type:'disabled'}。
 * glm-5.3（GLM Coding Plan 的主模型，routing.fast/code 常回落到它）永远思考：无控制时短输出
 * 额度被 reasoning 吃光（实测 512 max_tokens 里 reasoning 占 326-458，title 拿到空内容走降级档）；
 * 官方端点对 glm-5.3 直接拒绝 thinking.type=disabled（docs.z.ai/guides/capabilities/thinking）。
 * 低推理档 coding 端点实测 ~1s、0 reasoning tokens、正文完整。
 * quick 默认档 glm-5.3-flash 不在此列，请求体保持原样（逐字节不变）。
 */
export const QUICK_LANE_LOW_REASONING_EFFORT_MODELS: readonly string[] = ['glm-5.3'];

/**
 * 模型缩写 — 状态栏 ModelIndicator 显示用。
 * 2026-04-28 audit 前散落于 ModelIndicator.tsx，已迁移至此并清理 EOL 条目。
 */
export const MODEL_ABBREV: Record<string, string> = {
  // openai
  'gpt-6.1-sol': '6.1-sol',
  'gpt-6-sol': 'gpt-6-sol',
  'gpt-5.5': 'gpt-5.5',
  'gpt-5.5-pro': '5.5-pro',
  'gpt-5.4': 'gpt-5.4',
  'gpt-5.4-mini': '5.4-mini',
  'gpt-5.3-codex': '5.3-codex',
  'gpt-4o': 'gpt-4o',
  'gpt-4o-mini': '4o-mini',
  // claude (current)
  'claude-opus-4-7': 'opus-4.7',
  'claude-sonnet-4-6': 'sonnet-4.6',
  'claude-haiku-4-5-20251001': 'haiku-4.5',
  // deepseek
  'deepseek-flash': 'v4.1-flash',
  'deepseek-v4-flash': 'v4-flash',
  'deepseek-v4-pro': 'v4-pro',
  'deepseek-chat': 'deepseek',
  'deepseek-reasoner': 'reasoner',
  // gemini
  'gemini-3.1-pro-preview': 'gemini-3.1',
  'gemini-3-flash-preview': 'gemini-3f',
  // moonshot
  'kimi-k2.5': 'kimi-2.5',
  'kimi-k2.6': 'kimi-2.6',
  // LongCat
  'LongCat-2.0': 'LongCat',
  // zhipu
  'glm-5.1': 'glm-5.1',
  'glm-4.7': 'glm-4.7',
  'glm-4.7-flash': 'glm-flash',
  'glm-4-flash': 'glm-flash',
  'glm-5.3-flash': 'glm53-flash',
  // legacy / EOL — 保留 abbrev 防 historic session UI 退化（slice 截断）。
  // 新代码不应该再生成这些 model id；这些条目仅用于显示老会话状态栏（艾克斯 review LOW3）。
  'claude-3-5-sonnet': 'sonnet',
  'claude-3-5-sonnet-20241022': 'sonnet',
  'claude-3-opus': 'opus',
  'claude-3-opus-20240229': 'opus',
  'claude-3-haiku': 'haiku',
  'claude-3-haiku-20240307': 'haiku',
  'claude-sonnet-4-20250514': 'sonnet-4',
  'claude-opus-4-20250514': 'opus-4',
};

/** 智谱视觉模型（支持 base64）。glm-4.1v-thinking-flash 是免费档，带推理链。 */
export const ZHIPU_VISION_MODEL = 'glm-4.1v-thinking-flash' as const;

/**
 * visual_edit 工具专用模型配置 — 可被环境变量 override。
 * TEXT 路径：无截图时纯文本推理（source + intent）
 * VISION 路径：有截图时多模态推理（source + intent + image）
 * 默认值考虑 0ki 代理订阅的实际可用模型。
 */
export const VISUAL_EDIT_MODEL_TEXT = 'GLM-4.7' as const;
export const VISUAL_EDIT_MODEL_VISION = ZHIPU_VISION_MODEL;

/** Mermaid 在线渲染 API */
export const MERMAID_INK_API = 'https://mermaid.ink';

// ============================================================================
// Step 7 PR 1: Model domain capability — 单一权威源 (constants 路线)
//
// 与 UI 维度的 `ModelCapability` (shared/contract/model.ts, camelCase) 分离：
// 这里的 ModelDomainCapability 是 kebab-case 标签，喂给 CapabilityRecommender
// 做模型↔plugin 标签匹配用。`'tool'/'vision'/'reasoning'` 取自 MODEL_FEATURES
// 的字面量值；`'long-context'` 和 `'search'` 不回填到 MODEL_FEATURES，运行时按
// 上下文窗口或模型 id 派生（避免双源不一致）。
// ============================================================================

/**
 * 模型领域能力标签 (kebab-case)，喂给 CapabilityRecommender。
 *
 * 与 UI 的 `ModelCapability` (camelCase, 'longContext' / 'fast' / 'search' 等)
 * 受众不同——后者是给用户看的 chip，前者是给 recommender 做语义匹配的标签。
 */
export type ModelDomainCapability = 'tool' | 'vision' | 'reasoning' | 'long-context' | 'search';

/** `'long-context'` 判定阈值 — context window 超过该值即视为长上下文。 */
const LONG_CONTEXT_THRESHOLD = 100_000;

function modelIdLooksSearchCapable(modelId: string): boolean {
  return /sonar|search|perplexity/i.test(modelId);
}

/**
 * 判断 model 是否具备指定领域能力。
 *
 * 语义等价于 `getModelCapabilities(modelId).includes(cap)`，但是单次查询用
 * 这个函数避免分配数组。
 */
export function modelHasCapability(
  modelId: string,
  cap: ModelDomainCapability,
): boolean {
  if (cap === 'long-context') {
    return getContextWindow(modelId) > LONG_CONTEXT_THRESHOLD;
  }
  if (cap === 'search') {
    return modelIdLooksSearchCapable(modelId);
  }
  const features = MODEL_FEATURES[modelId];
  return features?.includes(cap) ?? false;
}
