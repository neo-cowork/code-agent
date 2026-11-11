// ============================================================================
// HttpFailureMessage - HTTP 失败 → 用户可见一句话（zh/en）
// ============================================================================
// transport 层对非 2xx 只保留 status/code 两个稳定信号，文案在这里按语言给；
// HTML 错误页与未捕获异常的文本永远不进气泡。代码位映射（如
// PROJECT_SOURCE_TRUST）优先于状态位映射；400/422 的业务文案由
// i18n/agentRunErrors.rejectedRequestMessage 在更上层按 code 分流，这里不重复。
// 唯一保留服务端文本的口子是 domainFailureMessage：域协议自己的业务错误信封。
// N-FIX-ATTACHMENT-ONLY-SEND-MISSING-PROMPT-FU1 复用同一份映射。
// ============================================================================

import type { Language } from '../i18n';
import { projectSourceTrustCopy } from '../i18n/agentRunErrors';

const genericFailure: Record<Language, string> = {
  zh: 'Neo 暂时没能完成这次请求，请稍后再试。',
  en: 'Neo could not complete the request; please try again in a moment.',
};

const accessDenied: Record<Language, string> = {
  zh: '本地服务没有接受这次请求，请刷新页面后重试。',
  en: 'The local session could not be verified. Refresh the page and try again.',
};

const busy: Record<Language, string> = {
  zh: '上一轮还没结束，请稍候再发送。',
  en: 'The previous turn is still finishing. Try again in a moment.',
};

const tooManyRequests: Record<Language, string> = {
  zh: '发送太频繁了，请稍等片刻再重试。',
  en: 'Too many requests in a short time. Wait a moment and try again.',
};

export interface HttpFailureMessageInput {
  status: number;
  code?: string;
  language: Language;
}

/** status/code → 一句话人话；未映射的状态回落到通用失败句（始终有返回）。 */
export function httpFailureMessage(input: HttpFailureMessageInput): string {
  const { status, code, language } = input;
  const pick = (copy: Record<Language, string>): string => copy[language] ?? copy.zh;
  if (code === 'PROJECT_SOURCE_TRUST') return pick(projectSourceTrustCopy);
  if (status === 401 || status === 403) return pick(accessDenied);
  if (status === 409) return pick(busy);
  if (status === 429) return pick(tooManyRequests);
  return pick(genericFailure);
}

// 域路由（src/web/routes/domain.ts）与终端错误处理（serverErrors.ts）自己的故障位：
// 带这些 code 的信封 message 是未捕获异常 / 鉴权 / 路由缺失的内部文本，不是业务答复。
const DOMAIN_ROUTE_FAILURE_CODES = new Set(['HANDLER_ERROR', 'NOT_FOUND', 'FORBIDDEN', 'INTERNAL_SERVER_ERROR']);

function readErrorEnvelope(body: string): { code?: string; message?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const record = parsed as { code?: unknown; error?: unknown };
  const error = record.error && typeof record.error === 'object'
    ? record.error as { code?: unknown; message?: unknown }
    : undefined;
  const code = typeof record.code === 'string' ? record.code
    : typeof error?.code === 'string' ? error.code : undefined;
  const message = typeof error?.message === 'string' && error.message.trim() ? error.message : undefined;
  return { code, message };
}

/**
 * domain 通道非 2xx → 信封 message。响应体本身是域协议的错误信封（error.message）且不带
 * 路由故障位时，是 handler 写给用户的业务答复，与 200 + success:false 同等对待、原样保留；
 * 其余（HTML 错误页、路由故障位、非信封 JSON）只按 status/code 出一句话。
 */
export function domainFailureMessage(input: { status: number; body: string; language: Language }): string {
  const { code, message } = readErrorEnvelope(input.body);
  if (message && code !== 'PROJECT_SOURCE_TRUST' && !(code && DOMAIN_ROUTE_FAILURE_CODES.has(code))) {
    return message;
  }
  return httpFailureMessage({ status: input.status, code, language: input.language });
}

/** 发送失败是不是旧项目 Source 身份快照缺失（失败气泡据此挂「确认并重发」入口）。 */
export function isProjectSourceTrustFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'PROJECT_SOURCE_TRUST';
}
