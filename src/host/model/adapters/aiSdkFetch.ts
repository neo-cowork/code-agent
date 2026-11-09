import axios, { type AxiosResponse } from 'axios';
import { Readable, Transform } from 'node:stream';
import { createLogger } from '../../services/infra/logger';
import { APICallError, JSONParseError } from 'ai';
import { getHttpsAgent } from '../providers/shared';

export const logger = createLogger('AiSdkAdapter');

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { out[key] = value; });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
  } else {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) out[key] = String(value);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function responseHeaders(headers: AxiosResponse['headers']): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const item of value) out.append(key, String(item));
    } else if (value !== undefined && value !== null) {
      out.set(key, String(value));
    }
  }
  return out;
}

function isNodeReadable(value: unknown): value is Readable {
  return value instanceof Readable
    || (typeof value === 'object'
      && value !== null
      && typeof (value as { pipe?: unknown }).pipe === 'function'
      && typeof (value as { on?: unknown }).on === 'function');
}

function requestBodyForAxios(body: BodyInit | null | undefined): unknown {
  if (body instanceof ReadableStream) {
    return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  }
  return body ?? undefined;
}

function toUint8Readable(readable: Readable): Readable {
  const transform = new Transform({
    transform(chunk: unknown, _encoding, callback) {
      if (typeof chunk === 'string') {
        callback(null, Buffer.from(chunk));
      } else if (chunk instanceof Uint8Array) {
        callback(null, chunk);
      } else if (chunk instanceof ArrayBuffer) {
        callback(null, Buffer.from(chunk));
      } else {
        callback(null, Buffer.from(String(chunk)));
      }
    },
  });
  readable.once('error', (err: Error) => transform.destroy(err));
  readable.once('close', () => {
    if (!readable.readableEnded) {
      transform.destroy(new Error('AI SDK response stream closed prematurely'));
    }
  });
  // 消费方提前停读（abort / 出错）时 Readable.toWeb 只销毁这个 Transform，不会顺着 pipe
  // 销毁 axios 的源响应流——IncomingMessage + zlib 解压流 + keep-alive socket 就此常驻
  // 事件循环（N-EVAL-CI-NOEXIT 持有者点名的 STREAM_END_OF_STREAM / ZLIB / TLSWRAP）。
  transform.once('close', () => {
    if (!readable.destroyed && !readable.readableEnded) {
      readable.destroy();
    }
  });
  return readable.pipe(transform);
}

function responseBodyForFetch(data: unknown, status: number): BodyInit | null {
  if (status === 204 || status === 304 || data == null) return null;
  if (isNodeReadable(data)) {
    return Readable.toWeb(toUint8Readable(data)) as BodyInit;
  }
  if (
    typeof data === 'string'
    || data instanceof Blob
    || data instanceof ArrayBuffer
    || ArrayBuffer.isView(data)
    || data instanceof FormData
    || data instanceof URLSearchParams
    || data instanceof ReadableStream
  ) {
    return data as BodyInit;
  }
  return JSON.stringify(data);
}

// 按 provider 生成 fetch：闭包绑定 provider，使 getHttpsAgent 能按 provider 身份决定走代理/直连
// （而非只看 url host）。修复 mimo 等「国内厂商海外节点」被全局代理打偏的问题。
export function makeAiSdkFetch(
  provider?: string,
  transformRequestBody?: (body: Record<string, unknown>) => Record<string, unknown>,
): typeof globalThis.fetch {
  return async (input, init) => {
  const request = input instanceof Request ? input : undefined;
  const url = input instanceof URL ? input.toString() : request?.url ?? String(input);
  const method = init?.method ?? request?.method ?? 'GET';
  const headers = headersToRecord(init?.headers ?? request?.headers);
  let body = requestBodyForAxios(init?.body ?? request?.body);
  // Vendor body quirks (e.g. mimo thinking:{type:'disabled'}, moonshot sampling)
  // are NOT a standard createOpenAICompatible option, so they must be applied to
  // the serialized JSON body here. Without this, transformRequestBody is dead
  // code and mimo defaults to thinking-ON → runaway reasoning (verified 2026-06-11:
  // full-content generation never starts, 65K reasoning tokens, finish=length).
  if (transformRequestBody && typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      body = JSON.stringify(transformRequestBody(parsed));
    } catch {
      // Non-JSON or unparsable body: leave untouched.
    }
  }
  const signal = init?.signal ?? request?.signal;
  const agent = getHttpsAgent(url, provider);

  if (process.env.CODE_AGENT_DUMP_MODEL_PAYLOAD) {
    const { dumpModelPayload } = await import('../modelPayloadDump');
    await dumpModelPayload({
      body,
      provider,
      protocol: /\/messages(?:[?#]|$)/.test(url) ? 'anthropic-messages' : 'chat-completions',
      url,
    });
  }

  const response = await axios({
    url,
    method,
    headers,
    data: body,
    signal,
    responseType: 'stream',
    timeout: 0,
    validateStatus: () => true,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    httpAgent: agent,
    httpsAgent: agent,
    proxy: false,
  });

  // HTTP 层错误在此落日志（带 URL）：AI SDK 上抛的 APICallError 往往只剩 statusText（如 "Not Found"），
  // 没有这条日志就无法定位 Base URL 配错（缺 /v1、末尾多斜杠等）
  if (response.status >= 400) {
    logger.warn(`[AiSdkAdapter] HTTP ${response.status} ${method} ${url}`);
  }
  // 流式请求收到的 2xx 却是 JSON/HTML/空体（非 SSE）：AI SDK 的 SSE 解析器会把它静默吞成「空回复」，
  // 调用方既没报错也没内容。这类体不是流，整体读出来：不能解析就抛 2xx APICallError（与非流式
  // generateText 同形态，交 classifyBadSuccessBody 分类），能解析的原样放行。
  const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
  const wantsStream = typeof body === 'string' && /"stream"\s*:\s*true/.test(body);
  const nonSseBody = /json|html|text\/plain/.test(contentType) || response.headers['content-length'] === '0';
  if (wantsStream && nonSseBody && response.status >= 200 && response.status < 300 && isNodeReadable(response.data)) {
    const chunks: Buffer[] = [];
    const iterator = (response.data as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    try {
      // content-type 不可信：中转站常把合法 SSE 标成 text/plain / application/json（SDK 的 SSE 解析不看它）。
      // 先偷看首个非空块，以 SSE 字段（data:/event:/id:/retry:/注释行）开头就当流，把首块接回去原样放行。
      for (;;) {
        const first = await iterator.next();
        if (first.done) break;
        const buf = Buffer.from(first.value);
        if (buf.length === 0) continue;
        if (/^\s*(?:data|event|id|retry):|^\s*:/.test(buf.toString('utf8', 0, 64))) {
          const rest = (async function* () { yield buf; for (;;) { const n = await iterator.next(); if (n.done) return; yield n.value; } })();
          return new Response(responseBodyForFetch(Readable.from(rest), response.status), {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders(response.headers),
          });
        }
        chunks.push(buf);
        break;
      }
      for (;;) {
        const n = await iterator.next();
        if (n.done) break;
        chunks.push(Buffer.from(n.value));
      }
    } catch (readErr) {
      if (signal?.aborted) throw readErr;
      // 体读到一半被掐：与 generateText 的「Failed to process successful response」同形态。
      throw new APICallError({
        message: 'Response body ended before it was complete',
        statusCode: response.status,
        url,
        requestBodyValues: undefined,
        cause: readErr,
      });
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      JSON.parse(text);
    } catch (parseErr) {
      throw new APICallError({
        message: 'Non-SSE response to a streaming request',
        statusCode: response.status,
        url,
        requestBodyValues: undefined,
        cause: new JSONParseError({ text, cause: parseErr }),
      });
    }
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response.headers),
    });
  }
  return new Response(responseBodyForFetch(response.data, response.status), {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response.headers),
  });
  };
}
