// ============================================================================
// ServerErrors - 5xx 观察者 + 终端错误处理（N-FIX-SIGNED-OUT-SEND-500-RAW-HTML-REDESIGN）
// ============================================================================
// Express 5 默认错误处理会回 HTML 错误页且不经过应用 logger（/api/run 预检抛错时
// 用户看到整页 HTML、日志停在 send_accepted）。这里两件套：
//   observeServerErrors —— 挂在路由前：显式 res.status(5xx).json 的响应也要留
//     一条带 method/route/status/reason 的 error 日志（这些不经过终端 handler）。
//   handleServerError —— 挂在所有路由之后：拒绝的 async handler 统一收口成
//     JSON {error, code}（无 HTML、无 stack）；headersSent 时按 Express 约定
//     next(err) 交给默认处理断开连接。
// 双日志防重：终端 handler 记过日志后置 res.locals.serverErrorLogged，观察者跳过。
// ============================================================================

import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ProjectSourceTrustError } from '../../host/services/project/projectSourceTrustError';
import type { WebRouteLogger } from '../routes/routeTypes';

function failureReason(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 观察者：任何 5xx 响应（含显式 status(5xx)）都补一条统一口径的 error 日志。 */
export function observeServerErrors(logger: WebRouteLogger): RequestHandler {
  return function serverErrorObserver(req, res, next) {
    let explicitReason: string | undefined;
    const rawJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 500 && body && typeof body === 'object') {
        const error = (body as { error?: unknown }).error;
        explicitReason = typeof error === 'string' ? error : undefined;
      }
      return rawJson(body);
    };
    res.once('finish', () => {
      if (res.statusCode < 500 || res.locals.serverErrorLogged) return;
      logger.error('Local server request failed', {
        method: req.method,
        route: req.path,
        status: res.statusCode,
        reason: explicitReason ?? res.statusMessage ?? 'Internal Server Error',
      });
    });
    next();
  };
}

/** 终端错误处理：JSON 应答 + error 日志；headersSent 时按 Express 指南 next(err)。 */
export function handleServerError(logger: WebRouteLogger): ErrorRequestHandler {
  return function serverErrorHandler(error, req, res, next) {
    if (res.headersSent) {
      next(error);
      return;
    }
    const candidate = error && typeof error === 'object' && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined;
    const isTrustError = error instanceof ProjectSourceTrustError;
    const status = isTrustError
      ? 422
      : typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
        ? candidate
        : 500;
    logger.error('Local server request failed', {
      method: req.method,
      route: req.path,
      status,
      reason: failureReason(error),
    });
    res.locals.serverErrorLogged = true;
    if (isTrustError) {
      res.status(status).json({
        error: 'Project folder needs trust confirmation',
        code: 'PROJECT_SOURCE_TRUST',
        kind: (error as ProjectSourceTrustError).kind,
      });
      return;
    }
    if (status >= 500) {
      // 5xx 不透传 message（可能带内部路径/细节），只回稳定码。
      res.status(status).json({ error: 'Local server request failed', code: 'INTERNAL_SERVER_ERROR' });
      return;
    }
    const code = error && typeof error === 'object' && 'code' in error
      && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : `HTTP_${status}`;
    res.status(status).json({ error: failureReason(error), code });
  };
}
