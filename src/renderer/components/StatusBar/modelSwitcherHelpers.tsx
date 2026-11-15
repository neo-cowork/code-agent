import React from 'react';
import { Eye, Wrench, Brain, Code2, Gauge } from 'lucide-react';
import type { BillingMode, ModelProvider, ModelProviderProtocol, ModelSearchCapabilityOverview } from '@shared/contract';
import type {
  AgentEngineModelCatalogModel,
  AgentEngineDescriptor,
  AgentEngineFailureDiagnostics,
  AgentEngineKind,
  AgentEngineSessionMetadata,
  ExternalAgentEngineKind,
} from '@shared/contract/agentEngine';
import { isProviderImageIcon, type RuntimeModelFeature, type RuntimeModelOptionGroup } from '@shared/modelRuntime';
import {
  getEngineBillingMode,
  getEngineModelCompat,
  type EngineBillingMode,
  type EngineModelCompatContext,
  type EngineModelCompatReasonCode,
} from '@shared/constants/engineCompat';
import { languages, type Translations } from '../../i18n';
import { interpolate } from '../../i18n/interpolate';
import { useAppStore } from '../../stores/appStore';
import type { EffortLevel } from '../../../shared/contract/agent';
import { getProviderLogoBadge, getProviderLogoMark } from './providerLogoCatalog';
import { useProviderIconImageSource } from '../../utils/providerIconAssets';
import { Badge } from '../primitives';

export const QUICK_SWITCH_PROVIDERS = [
  'moonshot',
  'xiaomi',
  'longcat',
  'deepseek',
  'zhipu',
  'openai',
  'claude',
  'gemini',
  'qwen',
  'minimax',
  'openrouter',
  'perplexity',
  'grok',
  'volcengine',
  'local',
  'custom',
] as const satisfies readonly ModelProvider[];

/**
 * 逐轮「联网搜索」开关可用判据（L0 2026-08-12 裁决）：
 * 当前模型注册表 capabilities 含 'search'（能力矩阵注册期单源回填）
 * 或有已就绪的外部搜索源（ExternalSearch 任何模型都能调，只要配了凭据）。
 * 两者都没有才置灰。overview 为 null（IPC 未返回/失败）时按不可用处理，不误报可用。
 */
export function resolveSearchToggleAvailability(
  overview: ModelSearchCapabilityOverview | null,
  provider: ModelProvider,
  model: string,
): boolean {
  if (!overview) return false;
  return Boolean(overview.modelsByProvider[provider]?.includes(model)) || overview.externalSearchReady;
}

export const ENGINE_SHORT_LABEL: Record<AgentEngineKind, string> = {
  native: 'Neo',
  codex_cli: 'Codex',
  claude_code: 'Claude',
  mimo_code: 'MiMo',
  kimi_code: 'Kimi',
  codebuddy_code: 'WorkBuddy',
  grok_cli: 'Grok',
  dsh_cli: 'dsh',
  kimi_code_acp: 'Kimi·ACP',
};

type ModelSwitcherCopy = Translations['modelSwitcherCopy'];

/**
 * 当前界面语言下的文案（FB-1489）。这个文件里是一批被很多组件调用的纯函数和标签表，
 * 语言直接从 store 读：组件在语言切换时会重渲染并重新调用它们。
 */
const copy = (): ModelSwitcherCopy => languages[useAppStore.getState?.().language ?? 'zh'].modelSwitcherCopy;

/** 按语言取值的标签表：用法和普通对象一样（TABLE[key]），每次读取都落到当前语言的那一份。 */
function localized<T extends object>(pick: (c: ModelSwitcherCopy) => T): T {
  return new Proxy({} as T, { get: (_target, key) => pick(copy())[key as keyof T] });
}

const ENGINE_RUNTIME_LABEL: Record<AgentEngineDescriptor['runtimeState'], string> = {
  ready: 'Ready',
  not_configured: 'Needs config',
  blocked: 'Blocked',
  error: 'Error',
  unknown: 'Unknown',
};

const ENGINE_RISK_LABEL: Record<AgentEngineDescriptor['riskTier'], string> = localized((c) => c.engineRisk);

const ENGINE_CLI_STATUS_LABEL: Record<NonNullable<AgentEngineDescriptor['reliability']>['cliStatus'], string> = localized((c) => c.engineCliStatus);

const ENGINE_AUTH_STATE_LABEL: Record<NonNullable<AgentEngineDescriptor['reliability']>['authState'], string> = localized((c) => c.engineAuthState);

const ENGINE_QUOTA_STATE_LABEL: Record<NonNullable<AgentEngineDescriptor['reliability']>['quotaState'], string> = localized((c) => c.engineQuotaState);

const ENGINE_STREAMING_MODE_LABEL: Record<NonNullable<AgentEngineDescriptor['reliability']>['streamingMode'], string> = localized((c) => c.engineStreamingMode);

const ENGINE_TRANSCRIPT_MODE_LABEL: Record<NonNullable<AgentEngineDescriptor['reliability']>['transcriptMode'], string> = localized((c) => c.engineTranscriptMode);

const ENGINE_TOOL_SUPPORT_LABEL: Record<NonNullable<AgentEngineDescriptor['reliability']>['toolSupport'], string> = localized((c) => c.engineToolSupport);

const ENGINE_FAILURE_LABEL: Record<AgentEngineFailureDiagnostics['category'], string> = localized((c) => c.engineFailure);

function formatEngineFailureAge(occurredAt?: number, now = Date.now()): string | null {
  if (typeof occurredAt !== 'number' || !Number.isFinite(occurredAt)) return null;
  const ageMs = Math.max(0, now - occurredAt);
  if (ageMs < 60_000) return copy().failedJustNow;
  if (ageMs < 60 * 60_000) return interpolate(copy().failedMinutesAgo, { count: Math.floor(ageMs / 60_000) });
  if (ageMs < 24 * 60 * 60_000) return interpolate(copy().failedHoursAgo, { count: Math.floor(ageMs / (60 * 60_000)) });
  return interpolate(copy().failedDaysAgo, { count: Math.floor(ageMs / (24 * 60 * 60_000)) });
}

export interface EffortOption {
  value: EffortLevel;
  label: string;
  shortLabel: string;
  color: string;
  tint: string;
}

const EFFORT_OPTION_CONFIG: Record<EffortLevel, EffortOption> = {
  low: {
    value: 'low',
    label: 'Low',
    get shortLabel() { return copy().effortShort.low; },
    color: 'text-zinc-400',
    tint: 'bg-zinc-700',
  },
  medium: {
    value: 'medium',
    label: 'Med',
    get shortLabel() { return copy().effortShort.medium; },
    color: 'text-badge-info',
    tint: 'bg-blue-500/15',
  },
  high: {
    value: 'high',
    label: 'High',
    get shortLabel() { return copy().effortShort.high; },
    color: 'text-badge-warning',
    tint: 'bg-amber-500/15',
  },
  xhigh: {
    value: 'xhigh',
    label: 'XHigh',
    get shortLabel() { return copy().effortShort.xhigh; },
    color: 'text-badge-warning',
    tint: 'bg-orange-500/15',
  },
  max: {
    value: 'max',
    label: 'Max',
    shortLabel: 'Max',
    color: 'text-badge-danger',
    tint: 'bg-rose-500/15',
  },
  ultra_code: {
    value: 'ultra_code',
    label: 'Ultra Code',
    shortLabel: 'Ultra',
    color: 'text-badge-success',
    tint: 'bg-emerald-500/15',
  },
};

const BASE_EFFORT_OPTIONS = [
  EFFORT_OPTION_CONFIG.low,
  EFFORT_OPTION_CONFIG.medium,
  EFFORT_OPTION_CONFIG.high,
];

const EXTENDED_EFFORT_OPTIONS = [
  ...BASE_EFFORT_OPTIONS,
  EFFORT_OPTION_CONFIG.xhigh,
  EFFORT_OPTION_CONFIG.max,
];

const CODE_EFFORT_OPTIONS = [
  ...BASE_EFFORT_OPTIONS,
  EFFORT_OPTION_CONFIG.xhigh,
  EFFORT_OPTION_CONFIG.ultra_code,
];

// 逐字段取值、不用展开：shortLabel 是按语言取值的 getter，展开会在模块加载时就读一次语言。
const SINGLE_EFFORT_OPTION: EffortOption[] = [
  {
    value: EFFORT_OPTION_CONFIG.low.value,
    color: EFFORT_OPTION_CONFIG.low.color,
    tint: EFFORT_OPTION_CONFIG.low.tint,
    label: 'Default',
    shortLabel: 'Default',
  },
];

const PROVIDER_LOGO_BADGE_CLASSNAME = 'bg-zinc-100 text-zinc-950 border border-zinc-300';

export const CAPABILITY_CONFIG: Record<string, { icon: React.ReactNode; color: string }> = {
  code: {
    icon: <Code2 className="w-2.5 h-2.5" />,
    color: 'bg-emerald-500/20 text-badge-success',
  },
  vision: {
    icon: <Eye className="w-2.5 h-2.5" />,
    color: 'bg-purple-500/20 text-badge-accent',
  },
  tool: {
    icon: <Wrench className="w-2.5 h-2.5" />,
    color: 'bg-blue-500/20 text-badge-info',
  },
  reasoning: {
    icon: <Brain className="w-2.5 h-2.5" />,
    color: 'bg-amber-500/20 text-badge-warning',
  },
  fast: {
    icon: <Gauge className="w-2.5 h-2.5" />,
    color: 'bg-sky-500/20 text-badge-info',
  },
  longContext: {
    icon: <span className="text-[9px] font-semibold">LC</span>,
    color: 'bg-fuchsia-500/20 text-badge-accent',
  },
};

const HEALTH_DOT_COLOR: Record<string, string> = {
  healthy: 'bg-mark-success',
  degraded: 'bg-mark-warning',
  unavailable: 'bg-mark-danger',
  recovering: 'bg-mark-info',
};

export interface ProviderHealthSnapshot {
  status?: string;
  latencyP50?: number;
  errorRate?: number;
  /** 供显示口径用（与宿主 ProviderHealthMonitor.isProviderDown 同一判据）：成功一次后旧的
   * unavailable 不再当坏。旧 Host 不带这两个字段——那时 unavailable 照实显示（429 熔断未成功
   * 不能改写成健康）。 */
  lastSuccessAt?: number;
  lastErrorAt?: number;
  /** 供应商级失败（密钥/网络/余额）才整家沉底；模型级停用不带这个。 */
  providerMark?: { kind: 'auth' | 'network' | 'quota' };
  modelMarks?: Record<string, { kind: 'model' | 'auth' | 'network' | 'quota' }>;
}

export type ProviderAvailabilityState = 'healthy' | 'recovering' | 'unknown' | 'degraded' | 'unavailable';

export interface ProviderHealthSummary {
  state: ProviderAvailabilityState;
  label: string;
  detail: string;
  rank: number;
  dotClass: string;
  badgeClass: string;
}

export interface ProviderBillingSummary {
  mode: BillingMode;
  label: string;
  detail: string;
  badgeClass: string;
}

const PROVIDER_HEALTH_RANK: Record<ProviderAvailabilityState, number> = {
  healthy: 0,
  recovering: 1,
  unknown: 2,
  degraded: 3,
  unavailable: 4,
};

const PROVIDER_HEALTH_LABEL: Record<ProviderAvailabilityState, string> = localized((c) => c.providerHealth);

const PROVIDER_HEALTH_BADGE_CLASS: Record<ProviderAvailabilityState, string> = {
  healthy: 'border-badge-success/20 bg-emerald-500/10 text-badge-success',
  recovering: 'border-badge-info/20 bg-sky-500/10 text-badge-info',
  unknown: 'border-zinc-700 bg-zinc-900 text-zinc-500',
  degraded: 'border-badge-warning/20 bg-amber-500/10 text-badge-warning',
  unavailable: 'border-red-500/20 bg-red-500/10 text-badge-danger',
};

const PROVIDER_BILLING_LABEL: Record<BillingMode, string> = localized((c) => c.billingLabel);

const PROVIDER_BILLING_DETAIL: Record<BillingMode, string> = localized((c) => c.billingDetail);

const PROVIDER_BILLING_BADGE_CLASS: Record<BillingMode, string> = {
  free: 'border-badge-success/20 bg-emerald-500/10 text-badge-success',
  plan: 'border-badge-info/20 bg-sky-500/10 text-badge-info',
  payg: 'border-badge-warning/20 bg-amber-500/10 text-badge-warning',
  unknown: 'border-zinc-700 bg-zinc-900 text-zinc-500',
};

function normalizeProviderAvailabilityState(status?: string): ProviderAvailabilityState {
  switch (status) {
    case 'healthy':
    case 'recovering':
    case 'degraded':
    case 'unavailable':
      return status;
    default:
      return 'unknown';
  }
}

/**
 * 显示口径：unavailable 但最近一次事件是成功（lastSuccessAt 不早于 lastErrorAt）→ 按「恢复中」的
 * 中性样式显示，不再当坏。与宿主 ProviderHealthMonitor.isProviderDown（手机 companionModelOptions
 * 的 providerDown）同一判据——成功一次即清，路由的恢复节奏（RECOVERY_SUCCESS_COUNT）只管选路，
 * 不拖住显示（同毫秒并列算已清，与宿主一致）。旧 Host 不带时间戳时照实显示 unavailable
 * （R6：429 连发且未再成功不许改写成健康）。
 */
function displayAvailabilityState(health: ProviderHealthSnapshot): ProviderAvailabilityState {
  const state = normalizeProviderAvailabilityState(health.status);
  if (state === 'unavailable'
    && typeof health.lastSuccessAt === 'number' && typeof health.lastErrorAt === 'number'
    && health.lastSuccessAt >= health.lastErrorAt) {
    return 'recovering';
  }
  return state;
}

export function buildProviderHealthSummary(health?: ProviderHealthSnapshot | null): ProviderHealthSummary {
  const state = health ? displayAvailabilityState(health) : 'unknown';
  const label = state === 'unknown' && health?.status ? copy().healthUnknown : PROVIDER_HEALTH_LABEL[state];
  const latencyLine = typeof health?.latencyP50 === 'number' && Number.isFinite(health.latencyP50)
    ? `P50 ${Math.round(health.latencyP50)}ms`
    : null;
  const errorLine = typeof health?.errorRate === 'number' && Number.isFinite(health.errorRate)
    ? interpolate(copy().errorRate, { percent: Math.round(health.errorRate * 100) })
    : null;
  const detail = [latencyLine, errorLine].filter(Boolean).join(' · ')
    || (health ? interpolate(copy().providerStatus, { status: health.status || 'unknown' }) : copy().healthNotReported);

  return {
    state,
    label,
    detail,
    rank: PROVIDER_HEALTH_RANK[state],
    dotClass: HEALTH_DOT_COLOR[state] ?? 'bg-mark-neutral',
    badgeClass: PROVIDER_HEALTH_BADGE_CLASS[state],
  };
}

export function compareProviderHealth(
  left?: ProviderHealthSnapshot | null,
  right?: ProviderHealthSnapshot | null,
): number {
  return buildProviderHealthSummary(left).rank - buildProviderHealthSummary(right).rank;
}

export function healthSnapshotForProviderSort(snapshot?: ProviderHealthSnapshot | null): ProviderHealthSnapshot | null | undefined {
  if (!snapshot) return snapshot;
  if (snapshot.providerMark) return { ...snapshot, status: 'unavailable' };
  // 不改写 unavailable：429 连发/超时这类不打标记的供应商级熔断要照常沉底显示，
  // 与路由的跳过行为一致。模型级失败不进 errorRate，不会误伤整家。
  return snapshot;
}

export function sortProviderGroupsByModelStrategy<T extends RuntimeModelOptionGroup>(
  groups: readonly T[],
  healthMap: Record<string, ProviderHealthSnapshot | undefined>,
): T[] {
  return [...groups].sort((left, right) => {
    const favoriteOrder = Number(right.providerFavorite === true) - Number(left.providerFavorite === true);
    if (favoriteOrder !== 0) return favoriteOrder;

    const leftProvider = left.options[0]?.provider ?? left.provider;
    const rightProvider = right.options[0]?.provider ?? right.provider;
    return compareProviderHealth(healthSnapshotForProviderSort(healthMap[leftProvider]), healthSnapshotForProviderSort(healthMap[rightProvider]));
  });
}

const AVAILABILITY_KIND_LABEL: Record<'model' | 'auth' | 'network' | 'quota', string> = localized((c) => c.availabilityKind);

export function buildModelRowHealthSummary(
  snapshot: ProviderHealthSnapshot | undefined,
  modelId: string,
): ProviderHealthSummary | null {
  const kind = snapshot?.providerMark?.kind ?? snapshot?.modelMarks?.[modelId]?.kind;
  if (kind) {
    return {
      state: 'unavailable',
      label: AVAILABILITY_KIND_LABEL[kind],
      detail: AVAILABILITY_KIND_LABEL[kind],
      rank: PROVIDER_HEALTH_RANK.unavailable,
      dotClass: HEALTH_DOT_COLOR.unavailable,
      badgeClass: PROVIDER_HEALTH_BADGE_CLASS.unavailable,
    };
  }
  if (!snapshot) return null;
  // 无标记的 unavailable 照实显示（429/超时熔断）：模型行不再改写成健康，界面与路由一致。
  return buildProviderHealthSummary(snapshot);
}

export function buildProviderBillingSummary(mode?: BillingMode | null): ProviderBillingSummary {
  const billingMode = mode ?? 'unknown';
  return {
    mode: billingMode,
    label: PROVIDER_BILLING_LABEL[billingMode],
    detail: PROVIDER_BILLING_DETAIL[billingMode],
    badgeClass: PROVIDER_BILLING_BADGE_CLASS[billingMode],
  };
}

export function ProviderBillingBadge({ summary }: { summary: ProviderBillingSummary }) {
  return (
    <Badge
      className={summary.badgeClass}
      title={summary.detail}
      data-provider-billing-mode={summary.mode}
    >
      {summary.label}
    </Badge>
  );
}

// ============================================================================
// 引擎级计费模式 + 模型兼容原因 — 文案全部经 i18n 由枚举/reasonCode 派生
// （矩阵数据来自 @shared/constants/engineCompat，本层只负责把它翻译成可见标签）
// ============================================================================

const ENGINE_BILLING_BADGE_CLASS: Record<EngineBillingMode, string> = {
  subscription: 'border-badge-info/20 bg-sky-500/10 text-badge-info',
  api_key_payg: 'border-badge-warning/20 bg-amber-500/10 text-badge-warning',
  free_tier: 'border-badge-success/20 bg-emerald-500/10 text-badge-success',
  unknown: 'border-zinc-700 bg-zinc-900 text-zinc-500',
};

export interface EngineBillingSummary {
  mode: EngineBillingMode;
  label: string;
  detail: string;
  badgeClass: string;
}

/** 把引擎 kind 翻成"订阅/按量/免费/未知"计费摘要（标签+hover 详情走 i18n）。 */
export function buildEngineBillingSummary(kind: AgentEngineKind, t: Translations): EngineBillingSummary {
  const mode = getEngineBillingMode(kind);
  const copy = t.engineCompat.billing[mode];
  return {
    mode,
    label: copy.label,
    detail: copy.detail,
    badgeClass: ENGINE_BILLING_BADGE_CLASS[mode],
  };
}

/** 把模型兼容 reasonCode 翻成可见原因文案（不可用 / 注解共用，纯 i18n 查表）。 */
export function resolveEngineModelCompatReason(
  reasonCode: EngineModelCompatReasonCode,
  t: Translations,
): string {
  return t.engineCompat.reason[reasonCode];
}

/**
 * 从签名目录模型列表构造兼容判定上下文：拆出"已启用 / 已停用"模型 id 集合，
 * 喂给 getEngineModelCompat（codex/claude 用）。mimo/kimi 无目录走直传，传空即可。
 */
/**
 * 单个引擎模型的兼容注解文案：disabledReason 是签名目录里更细的原文，优先展示；
 * 否则回落到 getEngineModelCompat 的 reasonCode 经 i18n 派生（mimo/kimi 的"由 CLI 解析"等）。
 */
const ENGINE_RELIABILITY_TONE_CLASS: Record<string, string> = {
  ready: 'border-badge-success/20 bg-emerald-500/[0.08] text-badge-success',
  warning: 'border-badge-warning/20 bg-amber-500/[0.08] text-badge-warning',
  error: 'border-red-500/20 bg-red-500/[0.08] text-badge-danger',
  info: 'border-badge-info/20 bg-sky-500/[0.08] text-badge-info',
};

const ENGINE_RELIABILITY_DOT_CLASS: Record<string, string> = {
  ready: 'bg-mark-success',
  warning: 'bg-mark-warning',
  error: 'bg-mark-danger',
  info: 'bg-mark-info',
};

/** 外部引擎可靠性摘要面板（tone 着色 + 摘要 + 能力/详情行）。 */
export function EngineBillingBadge({ summary }: { summary: EngineBillingSummary }) {
  return (
    <Badge
      className={summary.badgeClass}
      title={summary.detail}
      data-engine-billing-mode={summary.mode}
    >
      {summary.label}
    </Badge>
  );
}

export function ProviderHealthBadge({ summary }: { summary: ProviderHealthSummary }) {
  return (
    <Badge
      className={summary.badgeClass}
      dot={summary.dotClass}
      title={summary.detail}
      aria-label={interpolate(copy().providerStatus, { status: summary.label })}
      data-provider-health-state={summary.state}
    >
      {summary.label}
    </Badge>
  );
}

export function ProviderSourceBadge({ sourceLabel }: { sourceLabel?: string }) {
  if (!sourceLabel) return null;
  return (
    <span
      className="text-[10px] font-medium text-zinc-500"
      title={interpolate(copy().sourceTitle, { source: sourceLabel })}
      data-provider-source-label={sourceLabel}
    >
      {interpolate(copy().sourceText, { source: sourceLabel })}
    </span>
  );
}

function formatProviderEndpointDisplay(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return `${url.host}${path}`;
  } catch {
    return endpoint;
  }
}

export function ProviderTransportBadge({
  protocol,
  transportLabel,
  endpoint,
}: {
  protocol?: ModelProviderProtocol;
  transportLabel?: string;
  endpoint?: string;
}) {
  const label = transportLabel || (protocol === 'claude' ? 'Claude-compatible' : protocol === 'openai' ? 'OpenAI-compatible' : undefined);
  if (!label && !endpoint) return null;

  const endpointDisplay = endpoint ? formatProviderEndpointDisplay(endpoint) : undefined;
  const title = [
    label ? interpolate(copy().protocolTitle, { label }) : null,
    endpoint ? `Endpoint: ${endpoint}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <span
      className="max-w-[11rem] truncate text-[10px] font-medium text-zinc-400"
      title={title}
      data-provider-transport-protocol={protocol}
      data-provider-endpoint={endpoint}
    >
      {[label, endpointDisplay].filter(Boolean).join(' · ')}
    </span>
  );
}

/**
 * 把 provider 的检测状态/计费/来源/协议/endpoint 汇总成一段多行 tooltip 文本。
 * C-7：模型菜单 provider 头不再平铺这些工程内幕 badge，收进 hover 详情。
 */
export function buildProviderMetaTitle(group: {
  healthSummary: ProviderHealthSummary;
  billingSummary: ProviderBillingSummary;
  providerSourceLabel?: string;
  providerProtocol?: ModelProviderProtocol;
  providerTransportLabel?: string;
  providerEndpoint?: string;
}): string {
  const protocolLabel = group.providerTransportLabel
    || (group.providerProtocol === 'claude' ? 'Claude-compatible'
      : group.providerProtocol === 'openai' ? 'OpenAI-compatible' : undefined);
  return [
    interpolate(copy().metaStatus, { label: group.healthSummary.label, detail: group.healthSummary.detail }),
    interpolate(copy().metaBilling, { label: group.billingSummary.label, detail: group.billingSummary.detail }),
    group.providerSourceLabel ? interpolate(copy().sourceTitle, { source: group.providerSourceLabel }) : null,
    protocolLabel ? interpolate(copy().protocolTitle, { label: protocolLabel }) : null,
    group.providerEndpoint ? `Endpoint: ${group.providerEndpoint}` : null,
  ].filter(Boolean).join('\n');
}

export function getEngineUnavailableReason(
  descriptor: AgentEngineDescriptor,
  needsWorkspace: boolean,
): string | null {
  if (needsWorkspace) return copy().needsWorkspace;
  if (!descriptor.executable) return descriptor.lastError || copy().cliNotExecutable;
  if (descriptor.installState === 'missing') return descriptor.lastError || copy().notInstalled;
  if (descriptor.runtimeState === 'error' || descriptor.runtimeState === 'blocked') {
    return descriptor.lastError || ENGINE_RUNTIME_LABEL[descriptor.runtimeState];
  }
  return null;
}

export type EngineReliabilityTone = 'ready' | 'warning' | 'error' | 'info';

export interface EngineReliabilitySummary {
  tone: EngineReliabilityTone;
  label: string;
  summary: string;
  detail?: string;
  capabilityLine?: string;
}

export function formatEngineReliabilityContract(descriptor: AgentEngineDescriptor): string | null {
  const reliability = descriptor.reliability;
  if (!reliability) return null;
  const parts = [
    ENGINE_CLI_STATUS_LABEL[reliability.cliStatus],
    ENGINE_AUTH_STATE_LABEL[reliability.authState],
    ENGINE_QUOTA_STATE_LABEL[reliability.quotaState],
    ENGINE_STREAMING_MODE_LABEL[reliability.streamingMode],
    reliability.partialMessages ? 'partial messages' : null,
    ENGINE_TRANSCRIPT_MODE_LABEL[reliability.transcriptMode],
    ENGINE_TOOL_SUPPORT_LABEL[reliability.toolSupport],
    reliability.mcpBridge ? 'MCP bridge' : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function buildEngineReliabilitySummary(args: {
  descriptor: AgentEngineDescriptor | null;
  needsWorkspace: boolean;
  selectedModel?: AgentEngineModelCatalogModel | null;
  sessionFailure?: AgentEngineFailureDiagnostics | null;
  now?: number;
}): EngineReliabilitySummary | null {
  const { descriptor, needsWorkspace, selectedModel, sessionFailure, now } = args;
  if (!descriptor || descriptor.kind === 'native') return null;

  if (sessionFailure) {
    const reliabilityLine = descriptor.reliability
      ? formatEngineReliabilityContract({
        ...descriptor,
        reliability: {
          ...descriptor.reliability,
          ...sessionFailure.reliability,
        },
      })
      : null;
    return {
      tone: sessionFailure.retryable || sessionFailure.category === 'timeout' || sessionFailure.category === 'network'
        ? 'warning'
        : 'error',
      label: ENGINE_FAILURE_LABEL[sessionFailure.category],
      summary: sessionFailure.suggestion,
      detail: [
        sessionFailure.reason,
        formatEngineFailureAge(sessionFailure.occurredAt, now),
        typeof sessionFailure.statusCode === 'number' ? `HTTP ${sessionFailure.statusCode}` : null,
        typeof sessionFailure.exitCode === 'number' ? `exit ${sessionFailure.exitCode}` : null,
        sessionFailure.retryable ? copy().retryable : copy().needsAction,
      ].filter(Boolean).join(' · '),
      ...(reliabilityLine ? { capabilityLine: reliabilityLine } : {}),
    };
  }

  const unavailableReason = getEngineUnavailableReason(descriptor, needsWorkspace);
  if (unavailableReason) {
    const tone: EngineReliabilityTone =
      descriptor.installState === 'missing' || descriptor.runtimeState === 'error' || descriptor.runtimeState === 'blocked'
        ? 'error'
        : 'warning';
    return {
      tone,
      label: tone === 'error' ? copy().unavailableLabel : copy().needsHandlingLabel,
      summary: unavailableReason,
      detail: copy().unavailableDetail,
    };
  }

  if (descriptor.runtimeState === 'not_configured') {
    return {
      tone: 'warning',
      label: copy().needsConfigLabel,
      summary: interpolate(copy().needsConfigSummary, { engine: descriptor.label }),
      detail: descriptor.lastError,
    };
  }

  if (selectedModel?.disabledReason) {
    return {
      tone: 'warning',
      label: copy().modelLimitedLabel,
      summary: selectedModel.disabledReason,
      detail: copy().modelLimitedDetail,
    };
  }

  if (descriptor.runtimeState === 'unknown') {
    return {
      tone: 'info',
      label: copy().pendingLabel,
      summary: interpolate(copy().pendingSummary, { engine: descriptor.label }),
      detail: descriptor.lastError,
    };
  }

  const streamLine = descriptor.capabilities.includes('stream_events')
    ? copy().streamYes
    : copy().streamNo;
  const executionLine = descriptor.capabilities.includes('execute')
    ? copy().execYes
    : copy().execNo;
  const modelLine = selectedModel?.capabilities.includes('code')
    ? copy().modelCodeYes
    : copy().modelCodeNo;
  const modelMatchesAgentTasks = selectedModel?.capabilities.includes('code') ?? false;
  const reliabilityLine = formatEngineReliabilityContract(descriptor);

  return {
    tone: descriptor.capabilities.includes('execute') && modelMatchesAgentTasks ? 'ready' : 'info',
    label: copy().readyLabel,
    summary: interpolate(copy().readySummary, {
      engine: descriptor.label,
      model: selectedModel?.label ?? selectedModel?.id ?? copy().defaultSelection,
    }),
    capabilityLine: [streamLine, executionLine, modelLine, reliabilityLine].filter(Boolean).join(' · '),
  };
}

export function isExternalEngineKind(kind: AgentEngineKind): kind is ExternalAgentEngineKind {
  // 判据与 ExternalAgentEngineKind = Exclude<AgentEngineKind, 'native'> 的类型定义一致：
  // 所有非 native 引擎都是外部 CLI（renderer 不依赖 main 侧 agentEngineGuards，只共享这条 kind !== 'native' 判据）。
  // 旧实现只判 codex/claude，导致 mimo/kimi 在模型切换器里被当 native 处理（列不出 catalog 模型）。
  return kind !== 'native';
}

export function buildModelSwitcherEngineSelection(
  descriptor: AgentEngineDescriptor,
  workingDirectory?: string | null,
  model?: string | null,
): Partial<AgentEngineSessionMetadata> {
  const selection: Partial<AgentEngineSessionMetadata> = {
    kind: descriptor.kind,
    permissionProfile: descriptor.defaultPermissionProfile,
    origin: 'manual',
  };
  if (descriptor.kind !== 'native' && workingDirectory) {
    selection.cwd = workingDirectory;
  }
  if (descriptor.kind !== 'native' && model) {
    selection.model = model;
  }
  return selection;
}

export function ProviderLogo({ provider, label, icon }: { provider: ModelProvider; label: string; icon?: string }) {
  const imageSource = useProviderIconImageSource(icon);
  if (icon) {
    if (isProviderImageIcon(icon)) {
      return (
        <span
          aria-hidden="true"
          className={`inline-flex h-3.5 w-3.5 items-center justify-center overflow-hidden rounded-[3px] ${PROVIDER_LOGO_BADGE_CLASSNAME}`}
        >
          {imageSource ? (
            <img src={imageSource} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-[7px] font-bold leading-none">{label.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
      );
    }
    return (
      <span
        aria-hidden="true"
        className={`inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-[3px] px-[2px] text-[7px] font-bold leading-none ${PROVIDER_LOGO_BADGE_CLASSNAME}`}
      >
        {icon}
      </span>
    );
  }

  const mark = getProviderLogoMark(provider);
  if (mark) {
    const paths = mark.paths ?? (mark.path ? [mark.path] : []);
    return (
      <span
        aria-hidden="true"
        className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-[3px] ${PROVIDER_LOGO_BADGE_CLASSNAME}`}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-2.5 w-2.5 fill-current"
          role="img"
        >
          <title>{mark.title}</title>
          {paths.map((path) => (
            <path key={path} d={path} />
          ))}
        </svg>
      </span>
    );
  }

  const badge = getProviderLogoBadge(provider);
  const badgeLabel = badge?.label ?? (label.trim()[0] || provider[0] || '?').toUpperCase();

  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-[3px] px-[2px] text-[7px] font-bold leading-none ${PROVIDER_LOGO_BADGE_CLASSNAME}`}
    >
      {badgeLabel}
    </span>
  );
}

export function getProviderEffortOptions(
  provider: ModelProvider,
  model: string,
  features: readonly RuntimeModelFeature[] = [],
): EffortOption[] {
  if (provider === 'xiaomi') return BASE_EFFORT_OPTIONS;
  if (provider === 'claude') return EXTENDED_EFFORT_OPTIONS;
  if (provider === 'openai' && /codex|code/i.test(model)) return CODE_EFFORT_OPTIONS;
  if (provider === 'openai') return BASE_EFFORT_OPTIONS;
  if (provider === 'grok' || provider === 'perplexity') {
    return features.includes('reasoning') ? BASE_EFFORT_OPTIONS : SINGLE_EFFORT_OPTION;
  }
  return features.includes('reasoning') || /reason|thinking|think|r1|o\d/i.test(model)
    ? BASE_EFFORT_OPTIONS
    : SINGLE_EFFORT_OPTION;
}

export function getEngineEffortOptions(kind: AgentEngineKind): EffortOption[] {
  if (kind === 'codex_cli') return CODE_EFFORT_OPTIONS;
  if (kind === 'claude_code') return EXTENDED_EFFORT_OPTIONS;
  return BASE_EFFORT_OPTIONS;
}

export type ReasoningSegmentMode = 'active' | 'disabled_external' | 'hidden';

/** 原生沿用「不在配置提示里、且档位多于一档才展开」；任何非原生引擎都置灰，不把段藏掉。 */
export function getReasoningSegmentMode(args: {
  engineKind: AgentEngineKind;
  showModelSettingsPrompt: boolean;
  effortOptionCount: number;
}): ReasoningSegmentMode {
  if (args.engineKind !== 'native') return 'disabled_external';
  return !args.showModelSettingsPrompt && args.effortOptionCount > 1 ? 'active' : 'hidden';
}

export function getSelectedEffortOption(
  effortLevel: EffortLevel,
  options: readonly EffortOption[],
): EffortOption {
  return options.find((option) => option.value === effortLevel)
    ?? options.find((option) => option.value === 'high')
    ?? options[options.length - 1]
    ?? EFFORT_OPTION_CONFIG.high;
}

export interface ThinkingSegmentOption {
  value: 'auto' | 'off' | EffortLevel;
  label: string;
  selected: boolean;
  color: string;
  tint: string;
  onSelect: () => void;
}

/** 思考段选项：自动=保留复杂度分析；关/低/中/高=用户显式的逐轮选择（QE-01）。 */
export function buildThinkingSegmentOptions(params: {
  labels: {
    thinkingOptionAuto: string;
    thinkingOptionOff: string;
    thinkingOptionLow: string;
    thinkingOptionMedium: string;
    thinkingOptionHigh: string;
  };
  effortOptions: EffortOption[];
  thinkingEnabled: boolean;
  effortLevelExplicit: boolean;
  effortLevel: EffortLevel;
  setThinkingEnabled: (enabled: boolean) => void;
  setEffortLevel: (level: EffortLevel) => void;
  setAutomaticEffortLevel: () => void;
}): ThinkingSegmentOption[] {
  const {
    labels, effortOptions, thinkingEnabled, effortLevelExplicit, effortLevel,
    setThinkingEnabled, setEffortLevel, setAutomaticEffortLevel,
  } = params;
  return [
    {
      value: 'auto',
      label: labels.thinkingOptionAuto,
      selected: thinkingEnabled && !effortLevelExplicit,
      color: 'text-zinc-300',
      tint: 'bg-zinc-700',
      onSelect: () => {
        setThinkingEnabled(true);
        setAutomaticEffortLevel();
      },
    },
    {
      value: 'off',
      label: labels.thinkingOptionOff,
      selected: !thinkingEnabled,
      color: 'text-zinc-300',
      tint: 'bg-zinc-700',
      onSelect: () => setThinkingEnabled(false),
    },
    ...(['low', 'medium', 'high'] as const).map((level) => {
      const effortOption = effortOptions.find((option) => option.value === level);
      return {
        value: level as EffortLevel,
        label: level === 'low'
          ? labels.thinkingOptionLow
          : level === 'medium'
            ? labels.thinkingOptionMedium
            : labels.thinkingOptionHigh,
        selected: thinkingEnabled && effortLevelExplicit && effortLevel === level,
        color: effortOption?.color ?? 'text-zinc-300',
        tint: effortOption?.tint ?? 'bg-zinc-700',
        onSelect: () => {
          setThinkingEnabled(true);
          setEffortLevel(level);
        },
      };
    }),
  ];
}
