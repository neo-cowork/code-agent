import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ProjectSourceTrustError } from '../../host/services/project/projectSourceTrustError';
import type { WebRouteLogger } from '../routes/routeTypes';

/** Observe explicit 5xx responses as well as errors forwarded by Express. */
export function observeServerErrors(logger: WebRouteLogger): RequestHandler {
  return (req, res, next) => {
    let reason: unknown;
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 500 && body && typeof body === 'object') {
        const error = (body as { error?: unknown }).error;
        reason = typeof error === 'string' ? error : res.statusMessage;
      }
      return json(body);
    };
    res.once('finish', () => {
      if (res.statusCode >= 500 && !res.locals.serverErrorLogged) {
        logger.error('Local server request failed', {
          method: req.method, route: req.path, status: res.statusCode,
          reason: reason ?? res.statusMessage ?? 'Internal Server Error',
        });
      }
    });
    next();
  };
}

/** Register after every route so rejected async handlers cannot produce HTML. */
export function handleServerError(logger: WebRouteLogger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    const candidate = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    const status = error instanceof ProjectSourceTrustError ? 422
      : typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
        ? candidate : 500;
    logger.error('Local server request failed', {
      method: req.method, route: req.path, status,
      reason: error instanceof Error ? error.message : String(error),
    });
    res.locals.serverErrorLogged = true;
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(status).json({
      error: error instanceof ProjectSourceTrustError ? 'Project folder needs trust confirmation' : 'Local server request failed',
      code: error instanceof ProjectSourceTrustError ? 'PROJECT_SOURCE_TRUST'
        : status >= 500 ? 'INTERNAL_SERVER_ERROR' : `HTTP_${status}`,
    });
  };
}
