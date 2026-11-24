import { Router } from 'express';
import type { Request, Response } from 'express';
import { setDaemonQuitIntent } from '../../host/services/daemon/quitIntent';
import { createLogger } from '../../host/services/infra/logger';

const logger = createLogger('QuitGuard');

interface QuitGuardSnapshot {
  activeRuns: number;
  armedSchedules: number;
}

type QuitGuardLanguage = 'zh' | 'en';

interface QuitGuardRouterDeps {
  getSnapshot: () => Promise<QuitGuardSnapshot>;
  getLanguage?: () => QuitGuardLanguage;
}

function readIntegerCounts(snapshot: unknown): QuitGuardSnapshot | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const { activeRuns, armedSchedules } = snapshot as {
    activeRuns?: unknown;
    armedSchedules?: unknown;
  };
  if (typeof activeRuns !== 'number' || !Number.isInteger(activeRuns)) return null;
  if (typeof armedSchedules !== 'number' || !Number.isInteger(armedSchedules)) return null;
  return { activeRuns, armedSchedules };
}

export function createQuitGuardRouter(deps: QuitGuardRouterDeps): Router {
  const router = Router();

  router.get('/quit-guard', async (_req: Request, res: Response) => {
    try {
      const counts = readIntegerCounts(await deps.getSnapshot());
      if (!counts) {
        logger.warn('quit-guard snapshot unavailable', 'non-integer snapshot');
        res.status(500).json({ error: 'quit-guard-unavailable' });
        return;
      }
      let language: QuitGuardLanguage = 'zh';
      if (deps.getLanguage) {
        try {
          language = deps.getLanguage() === 'en' ? 'en' : 'zh';
        } catch (error) {
          logger.warn('quit-guard language unavailable; falling back to zh', error);
        }
      }
      res.json({ ...counts, language });
    } catch (error) {
      logger.warn('quit-guard snapshot unavailable', error);
      res.status(500).json({ error: 'quit-guard-unavailable' });
    }
  });

  // 壳声明「停止并退出」意图（ADR-083）：HTTP 面只接 mode=stop——stop 把
  // 下一次 stdin EOF 变成全平台停机指令。「后台继续」是壳不退出，壳不发
  // 任何 HTTP 声明；background 只剩进程内 setDaemonQuitIntent 入口。
  router.post('/quit-intent', (req: Request, res: Response) => {
    const { mode } = (req.body ?? {}) as { mode?: unknown };
    if (mode !== 'stop') {
      res.status(400).json({ error: 'invalid-quit-intent' });
      return;
    }
    setDaemonQuitIntent(mode);
    res.json({ ok: true, mode });
  });

  return router;
}
