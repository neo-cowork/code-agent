/**
 * HTTP 2xx 但响应体不可用（截断 JSON / 空体 / HTML 网关页）的结构化识别。
 *
 * AI SDK 把这类失败包成 statusCode=2xx 的 APICallError：
 *  - 体能读完但不是合法 JSON → cause 是 JSONParseError（带原文 text）；
 *  - 体读到一半连接被掐 → cause 是传输层 Error（没有原文）。
 * 默认 isRetryable 对 2xx 恒为 false，且 SDK 不保留原文，所以分类放在 Neo 适配器这一层。
 * 判定一律看结构（APICallError + 状态码 + cause 类型），不匹配 SDK 的英文 message。
 */
import { APICallError, JSONParseError } from 'ai';
import { INCOMPLETE_RESPONSE_DIAGNOSTIC } from '../../../shared/modelErrorDiagnostics';
import { redactSecrets } from '../../security/secretRedaction';

export type BadSuccessBodyKind = 'truncated_json' | 'empty_body' | 'html_page' | 'other';

export interface BadSuccessBodyInfo {
  kind: BadSuccessBodyKind;
  /** 原始体前 ~200 字符（已过密钥掩码）；传输层截断时没有原文，为空串。 */
  snippet: string;
}

/** 坏体最多重试一次：同类重放没有收益，也不能进紧循环。 */
export const BAD_SUCCESS_BODY_MAX_RETRIES = 1;

const SNIPPET_MAX_CHARS = 200;

/** 非 2xx、非 APICallError、或 cause 不是「坏体」形态时返回 null。 */
export function classifyBadSuccessBody(err: unknown): BadSuccessBodyInfo | null {
  // 只认错误本身：下面 toBadSuccessBodyUserError 产出的终态包装（cause 指向原错误）不能再被判成可重试。
  const apiErr = APICallError.isInstance(err) ? err : null;
  const status = apiErr?.statusCode;
  if (!apiErr || status === undefined || status < 200 || status >= 300) return null;
  const cause = apiErr.cause;
  if (!cause) return null;

  if (JSONParseError.isInstance(cause)) {
    const text = cause.text ?? '';
    const snippet = redactSecrets(text.slice(0, SNIPPET_MAX_CHARS));
    if (text.trim().length === 0) return { kind: 'empty_body', snippet };
    if (/^\s*</.test(text)) return { kind: 'html_page', snippet };
    return { kind: 'truncated_json', snippet };
  }
  // 合法 JSON 但结构不符（TypeValidationError）不是「不完整」，不归本类。
  if (typeof cause === 'object' && (cause as { name?: unknown }).name === 'AI_TypeValidationError') {
    return { kind: 'other', snippet: '' };
  }
  // 体读取中途失败（连接被掐 / 提前关闭）：内容被截断，没有原文可取。
  return { kind: 'truncated_json', snippet: '' };
}

/** 可重试的坏体类别（other 不重试）。 */
export function isRetryableBadSuccessBody(err: unknown): boolean {
  const info = classifyBadSuccessBody(err);
  return !!info && info.kind !== 'other';
}

/** 命中时返回供 logger.warn 使用的一行文案；未命中返回 null。 */
export function describeBadSuccessBody(err: unknown): string | null {
  const info = classifyBadSuccessBody(err);
  if (!info) return null;
  return `[AiSdkAdapter] 2xx 响应体不可用 class=${info.kind} snippet=${JSON.stringify(info.snippet)}`;
}

/**
 * 重试用尽后的终态错误：message 换成面向用户的一句话，原错误挂在 cause。
 * 子代理摘要、失败卡片、落库的 error 文本都取 err.message，所以在这里换一次即可全链路生效。
 * 未命中（含 other）原样返回。
 */
export function toBadSuccessBodyUserError(err: unknown): unknown {
  if (!isRetryableBadSuccessBody(err)) return err;
  const { message, suggestion } = INCOMPLETE_RESPONSE_DIAGNOSTIC;
  return new Error(`${message}\n建议：${suggestion}`, { cause: err });
}
