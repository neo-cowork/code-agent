// ============================================================================
// 定时 / 云端失败的人话分类（N-CRON-FAIL-PLAIN）
//
// 纯函数，host 通知和执行详情共用同一份。只认报文字面：
// 登录墙码、classifyAgentError 的类别，以及额度报文里写明的窗口和重置时间。
// 429 常和 GLM 1308/1310 叠在同一段文字里，额度信号必须先于限流，否则额度会被吞成限流。
// 重置时间只从 next_flush_time / "reset(s) at <datetime>" / "将在 <datetime> 重置" 解析，
// 解析不到就留空，调用方写「以服务商为准」，不许推算。
// ============================================================================

import { parseCronLoginWallStop } from './browserLoginWall';
import { classifyAgentError } from './agentErrorClassification';
import { isCronCloudUnavailableError } from './cronCloudUnavailable';
import { isCronRuntimeNotReadyError } from './cronRuntimeNotReady';
import type { ProjectSourceTrustFailureKind } from '../contract/project';

export const CRON_FAILURE_CODE = 'CRON_FAILURE' as const;

export type CronFailurePresentationKind =
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'auth'
  | 'network'
  | 'login_wall'
  | 'cloud_unavailable'
  | 'runtime_starting'
  | 'project_trust'
  | 'other';

export interface CronFailureClassification {
  kind: CronFailurePresentationKind;
  /** 报文里服务商自己写的窗口词（如 "5-hour window"）。没有就不填。 */
  limitText?: string;
  /** ISO-8601。只有报文写明了重置时间才填。 */
  resetAt?: string;
  /** project_trust 专用：项目文件夹信任失败的具体类型。 */
  trustKind?: ProjectSourceTrustFailureKind;
  /** project_trust 专用：文件夹名（单段，绝不含路径分隔符）。拿不到安全的名字就不填。 */
  folderName?: string;
}

// 项目文件夹信任失败落库成稳定标记 PROJECT_SOURCE_TRUST:<kind>[:<folderName>]，
// 不落 ProjectSourceTrustError.message（英文句 + 本机绝对路径）。显示时再翻译。
const PROJECT_TRUST_MARKER_PREFIX = 'PROJECT_SOURCE_TRUST';
const PROJECT_TRUST_KINDS: readonly ProjectSourceTrustFailureKind[] = ['source_missing', 'identity_changed', 'not_trusted'];
// 存量行：messageFor 的三句英文前缀，路径取最后一段当文件夹名。
const LEGACY_PROJECT_TRUST_TEXT = /Project Source (is missing|trust identity changed|is not trusted): ([^\n]*)/;
const LEGACY_PROJECT_TRUST_KIND: Record<string, ProjectSourceTrustFailureKind> = {
  'is missing': 'source_missing',
  'trust identity changed': 'identity_changed',
  'is not trusted': 'not_trusted',
};

function isProjectTrustKind(value: unknown): value is ProjectSourceTrustFailureKind {
  return typeof value === 'string' && (PROJECT_TRUST_KINDS as readonly string[]).includes(value);
}

/** 与 ProjectSourceTrustError.toHttpBody 同一条规则：单段、非 . / ..、不含分隔符。 */
function safeFolderSegment(value: string | undefined): string | undefined {
  const name = value?.trim();
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return undefined;
  return name;
}

function lastPathSegment(path: string): string | undefined {
  const segments = path.trim().split(/[\\/]+/).filter(Boolean);
  return safeFolderSegment(segments[segments.length - 1]);
}

function projectTrustMarker(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  for (let depth = 0; depth < 6 && cursor != null && typeof cursor === 'object' && !seen.has(cursor); depth += 1) {
    seen.add(cursor);
    const record = cursor as { code?: unknown; kind?: unknown; sourcePath?: unknown; cause?: unknown };
    if (record.code === PROJECT_TRUST_MARKER_PREFIX && isProjectTrustKind(record.kind)) {
      const folderName = typeof record.sourcePath === 'string' ? lastPathSegment(record.sourcePath) : undefined;
      return [PROJECT_TRUST_MARKER_PREFIX, record.kind, ...(folderName ? [folderName] : [])].join(':');
    }
    cursor = record.cause;
  }
  return undefined;
}

// 标记不一定在开头：事件决策台账把 execution.error 原样拼进「run <status>: <原因>」
// （cronEventDecisions），所以按词边界认标记本身，文件夹名取到文本末尾，与落库格式一致。
const PROJECT_TRUST_MARKER_TEXT = /\bPROJECT_SOURCE_TRUST:(source_missing|identity_changed|not_trusted)(?::([\s\S]*))?/;

interface ProjectTrustFailureMatch {
  classification: CronFailureClassification;
  /** 命中的那一段原文（标记或存量英文句）：显示方据此把它整段换成人话。 */
  text: string;
}

/** 文本里的项目文件夹信任失败：稳定标记或存量英文句。没有返回 undefined。 */
export function matchProjectTrustFailure(text: string): ProjectTrustFailureMatch | undefined {
  const marker = text.match(PROJECT_TRUST_MARKER_TEXT);
  const markerKind = marker?.[1];
  if (marker && isProjectTrustKind(markerKind)) {
    const folderName = safeFolderSegment(marker[2]);
    return {
      classification: { kind: 'project_trust', trustKind: markerKind, ...(folderName ? { folderName } : {}) },
      text: marker[0],
    };
  }
  const legacy = text.match(LEGACY_PROJECT_TRUST_TEXT);
  if (!legacy) return undefined;
  const folderName = lastPathSegment(legacy[2]);
  return {
    classification: { kind: 'project_trust', trustKind: LEGACY_PROJECT_TRUST_KIND[legacy[1]], ...(folderName ? { folderName } : {}) },
    text: legacy[0],
  };
}

const CRON_TIME_LIMIT_TEXT = /Cron job run exceeded its (\d+(?:\.\d+)?)s time limit\./;
const QUOTA_TEXT = /\b1308\b|\b1310\b|usage limit/i;
// 国内 provider 的 401 文案是中文（GLM 实测「令牌已过期或验证不正确」），classifyAgentError
// 的英文关键词认不出就会漏成 other，这里补认这些**成句的鉴权措辞**。裸 401 不扫：错误原文是
// 上游自由文本（R2 教训），「请 401 秒后重试」/回显的 URL、shell 输出都可能带独立 401，裸扫会把
// 限流误判成鉴权、引着用户去改没坏的 key。401 的结构化判定在 host 侧 getModelAuthFailureMarker
// （只读 status/code 字段）；落到文本层时 classifyAgentError 也只在 401 搭配 invalid api key /
// unauthorized 等措辞时才认 auth，两边口径一致。
const AUTH_TEXT = /令牌已过期|验证不正确|鉴权失败|api\s*key\s*(无效|过期|不正确)/i;
const LIMIT_TEXT = /(\d+\s*-?\s*hours?(?:\s+window)?)|(\d+\s*小时(?:窗口|额度)?)|(每周|每月|周额度|月额度)|\b(weekly|monthly|per week|per month)\b/i;
const ISO_LIKE = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;
const SOURCE_TEXT_LIMIT = 4000;

function quotaResult(text: string): CronFailureClassification {
  const limit = text.match(LIMIT_TEXT)?.[0]?.trim();
  const resetAt = parseResetAt(text);
  const result: CronFailureClassification = { kind: 'quota' };
  if (limit) result.limitText = limit.length > 40 ? limit.slice(0, 40) : limit;
  if (resetAt) result.resetAt = resetAt;
  return result;
}

/** 把明确写出的时间点收成 ISO。认不出就返回 undefined，不拿 Date.parse 猜自由文本。 */
function toIso(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^["']|["']$/g, '');
  if (/^\d{10,13}$/.test(trimmed)) {
    const ms = trimmed.length >= 13 ? Number(trimmed) : Number(trimmed) * 1000;
    const date = new Date(ms);
    const year = date.getUTCFullYear();
    if (!Number.isFinite(date.getTime()) || year < 2000 || year > 2100) return undefined;
    return date.toISOString();
  }
  const matched = trimmed.match(ISO_LIKE);
  if (!matched) return undefined;
  const normalized = matched[1].includes('T') ? matched[1] : matched[1].replace(' ', 'T');
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toISOString();
}

function parseResetAt(text: string): string | undefined {
  const flush = text.match(/next_flush_time["']?\s*[:=]\s*["']?([0-9T:Z+\-.]+)/i);
  if (flush?.[1]) {
    const iso = toIso(flush[1]);
    if (iso) return iso;
  }
  const english = text.match(/resets?\s+at\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i);
  if (english?.[1]) {
    const iso = toIso(english[1]);
    if (iso) return iso;
  }
  const chinese = text.match(/将在\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s*重置/);
  if (chinese?.[1]) {
    const iso = toIso(chinese[1]);
    if (iso) return iso;
  }
  return undefined;
}

export function classifyCronFailure(error?: string): CronFailureClassification {
  const text = error?.trim() ?? '';
  if (!text) return { kind: 'other' };
  const projectTrust = matchProjectTrustFailure(text);
  if (projectTrust) return projectTrust.classification;
  if (parseCronLoginWallStop(text)) return { kind: 'login_wall' };
  // 云端调度器不可用的固定句先于额度/鉴权/网络：executeJob 落库时会把 cause 报文
  // （fetch failed / 401 等）追加在句子后面，先认固定句才不会被底因冲掉。
  if (isCronCloudUnavailableError(text)) return { kind: 'cloud_unavailable' };
  if (isCronRuntimeNotReadyError(text)) return { kind: 'runtime_starting' };
  if (CRON_TIME_LIMIT_TEXT.test(text)) return { kind: 'timeout' };
  // 额度报文经常带着 HTTP 429。先认额度，避免被 classifyAgentError 收成 rate_limited。
  if (QUOTA_TEXT.test(text)) return quotaResult(text);
  if (AUTH_TEXT.test(text)) return { kind: 'auth' };

  const category = classifyAgentError({ message: text })?.category;
  if (category === 'insufficient_balance') return quotaResult(text);
  if (category === 'rate_limited' || category === 'concurrency') return { kind: 'rate_limit' };
  if (category === 'auth') return { kind: 'auth' };
  if (category === 'network') {
    const normalized = text.toLowerCase();
    if (normalized.includes('timeout') || normalized.includes('timed out')) return { kind: 'timeout' };
    return { kind: 'network' };
  }
  return { kind: 'other' };
}

/**
 * 落库用的失败原文。重试包装只留 "Retry stopped…"，服务商报文在 cause.responseBody 上；
 * 不把那段拼回来，执行详情就看不到 1308 / next_flush_time。
 * 普通 Error 没有 cause 时结果等于 message，登录墙码保持原样。
 * 例外：云端调度器不可用的固定句是终点——cause 里是英文原始报文，拼进 execution.error
 * 会让中文界面中英混排（FB-547）；底因由 CronCloudRuntime.runJob 落 console.warn。
 */
export function cronFailureSourceText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!(error instanceof Error) && (typeof error !== 'object' || error === null)) return String(error);
  // 项目文件夹信任失败：只落稳定标记，英文句和本机绝对路径不进库。
  const trustMarker = projectTrustMarker(error);
  if (trustMarker) return trustMarker;

  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  for (let depth = 0; depth < 6 && cursor != null && typeof cursor === 'object' && !seen.has(cursor); depth += 1) {
    seen.add(cursor);
    const record = cursor as { message?: unknown; responseBody?: unknown; cause?: unknown };
    if (typeof record.message === 'string' && record.message) {
      parts.push(record.message);
      // 固定句自带完整人话指引，到此为止：再往下收就是把英文原始报文追加到
      // 界面语言句子上（FB-547 中英混排）。存量混排行仍靠 classifyCronFailure 认固定句。
      if (isCronCloudUnavailableError(record.message)) break;
    }
    if (typeof record.responseBody === 'string') {
      const body = record.responseBody.trim();
      if (body && !parts.join('\n').includes(body)) parts.push(body);
    }
    cursor = record.cause;
  }
  const text = parts.join('\n');
  return text.length > SOURCE_TEXT_LIMIT ? `${text.slice(0, SOURCE_TEXT_LIMIT)}…` : text;
}
