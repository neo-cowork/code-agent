// ============================================================================
// genericProviderReason — generic 失败卡的「服务商返回」短句清洗
//
// 仅当脱敏后的 rawMessage 是一句用户可读短话（≤80 字、单行、无 URL/JSON/堆栈/ID/
// 密钥、且语言与当前界面一致）时返回，否则返回 null（卡片保持原样，不向用户倾倒
// 英文堆栈或机器噪音）。
// ============================================================================

import { redactCredentialText } from '@shared/security/secretPatterns';

const MAX_PROVIDER_REASON_CHARS = 80;
const CJK_RE = /[\u4e00-\u9fff]/;

const DISALLOWED_PATTERNS: readonly RegExp[] = [
  /https?:\/\/|wss?:\/\/|\bwww\./i,
  /[{}[\]]/,
  /\bat\s+[\w$.<>]+\s*\(/,
  /\b[\w./-]+:\d+:\d+\b/,
  /\b[A-Za-z][\w.]*(?:Error|Exception)\b/,
  /\b(?:E[A-Z]{3,}|ERR_[A-Z0-9_]+)\b/,
  /\bTraceback \(most recent call last\)/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\b(?:req|trace|request|session|task|run|msg|chatcmpl|cmpl)[_-][A-Za-z0-9_-]{4,}\b/i,
  /\b(?:sk|pk|rk|ak|ghp|gho|xox[baprs])-[A-Za-z0-9_-]{6,}\b/i,
  /\b[0-9a-f]{16,}\b/i,
  /\b[A-Za-z0-9_-]{24,}\b/,
];

export function extractReadableProviderReason(
  rawMessage: string | undefined | null,
  language: 'zh' | 'en',
): string | null {
  if (typeof rawMessage !== 'string') return null;
  if (/[\r\n]/.test(rawMessage)) return null;

  const trimmed = rawMessage.trim();
  if (!trimmed || trimmed.length > MAX_PROVIDER_REASON_CHARS) return null;

  const redacted = redactCredentialText(trimmed);
  if (redacted !== trimmed || redacted.includes('[REDACTED]') || redacted.includes('redacted]')) {
    return null;
  }

  for (const pattern of DISALLOWED_PATTERNS) {
    if (pattern.test(trimmed)) return null;
  }

  const hasCjk = CJK_RE.test(trimmed);
  if (language === 'zh') {
    if (!hasCjk) return null;
    // 中文界面下拒绝夹带大段英文机器短语的混合报错
    if (/[A-Za-z]{4,}(?:\s+[A-Za-z]{4,}){2,}/.test(trimmed)) return null;
  } else {
    if (hasCjk) return null;
    if (!/[A-Za-z]/.test(trimmed)) return null;
  }

  return trimmed;
}
