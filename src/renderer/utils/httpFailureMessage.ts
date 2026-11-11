// ============================================================================
// HttpFailureMessage - HTTP 失败 → 用户可见一句话（zh/en）
// ============================================================================
// transport 层对非 2xx 只保留 status/code 两个稳定信号，文案在这里按语言给；
// 响应体（含 JSON message 与 HTML 错误页）永远不进气泡。代码位映射（如
// PROJECT_SOURCE_TRUST）优先于状态位映射；400/422 的业务文案由
// i18n/agentRunErrors.rejectedRequestMessage 在更上层按 code 分流，这里不重复。
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
