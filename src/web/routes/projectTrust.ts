// ============================================================================
// ProjectTrust 路由 - 聊天内「确认并重发」的信任恢复入口
// ============================================================================
// POST /api/project/confirm-source-trust { sessionId }：重拍该会话所属 Project 里
// 快照缺失的 trusted Source 的身份快照（setFolderTrust + 既有 updateProject 路径）。
// 客户端只给 sessionId——Source 集合、路径、身份全部从服务端台账/文件系统现读，
// 永不接受客户端路径。细节见 host/services/project/projectSourceTrustRecovery.ts。
// ============================================================================

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Session } from '../../shared/contract';
import { getProjectService } from '../../host/services/project/projectService';
import {
  confirmSessionProjectSources,
  ProjectTrustConfirmError,
} from '../../host/services/project/projectSourceTrustRecovery';
import type { WebRouteLogger } from './routeTypes';

interface ProjectTrustRouterDeps {
  logger: WebRouteLogger;
  tryGetSessionManager: () => Promise<{
    getSession?(sessionId: string, limit?: number): Promise<Session | null>;
  } | null>;
}

export function createProjectTrustRouter(deps: ProjectTrustRouterDeps): Router {
  const router = Router();
  router.post('/confirm-source-trust', async (req: Request, res: Response) => {
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required', code: 'PROJECT_TRUST_CONFIRM_INVALID_BODY' });
      return;
    }
    const sessionManager = await deps.tryGetSessionManager();
    const session = await sessionManager?.getSession?.(sessionId, 1) ?? null;
    const projectId = session?.projectId?.trim();
    if (!session || !projectId) {
      res.status(404).json({ error: 'Session not found', code: 'PROJECT_TRUST_CONFIRM_SESSION_NOT_FOUND' });
      return;
    }
    try {
      const result = await confirmSessionProjectSources({
        projectId,
        projects: getProjectService(),
      });
      deps.logger.info('[ProjectTrust] session project sources confirmed', { sessionId, projectId, sources: result.sources });
      res.json({ confirmed: true, sources: result.sources });
    } catch (error) {
      if (error instanceof ProjectTrustConfirmError) {
        deps.logger.warn('[ProjectTrust] confirmation rejected', { sessionId, projectId, reason: error.reason });
        res.status(422).json({
          error: 'Project folder trust could not be re-confirmed',
          code: 'PROJECT_TRUST_CONFIRM_REJECTED',
          reason: error.reason,
        });
        return;
      }
      throw error;
    }
  });
  return router;
}
