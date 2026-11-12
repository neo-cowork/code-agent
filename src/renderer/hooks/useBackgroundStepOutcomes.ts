// 后台任务行的「步骤失败」信号：host 只回 completed/failed，渲染端对已收尾且无结束消息的条目
// 经既有 session.load 读一次消息，数工具步骤失败数，与前台面板同一口径（terminalWord.countToolSteps）。
import { useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { BackgroundSessionInfo } from '@shared/contract/sessionState';
import { createLogger } from '../utils/logger';
import { countToolSteps } from '../utils/terminalWord';

const logger = createLogger('BackgroundStepOutcomes');

type StepOutcome = ReturnType<typeof countToolSteps>;

export function useBackgroundStepOutcomes(
  sessions: ReadonlyArray<Pick<BackgroundSessionInfo, 'sessionId' | 'status' | 'completionMessage'>>,
): Record<string, StepOutcome> {
  const [outcomes, setOutcomes] = useState<Record<string, StepOutcome>>({});
  const pending = sessions
    .filter((s) => s.status === 'completed' && !s.completionMessage && !(s.sessionId in outcomes))
    .map((s) => s.sessionId)
    .join('|');

  useEffect(() => {
    if (!pending) return;
    let active = true;
    for (const sessionId of pending.split('|')) {
      void (async () => {
        try {
          const response = await window.domainAPI?.invoke<{ messages?: Parameters<typeof countToolSteps>[0] } | null>(
            IPC_DOMAINS.SESSION, 'load', { sessionId },
          );
          if (!active) return;
          if (!response?.success) {
            logger.warn('Background session load failed, row keeps host status word', { sessionId, code: response?.error?.code });
            setOutcomes((prev) => ({ ...prev, [sessionId]: undefined }));
            return;
          }
          setOutcomes((prev) => ({ ...prev, [sessionId]: countToolSteps(response.data?.messages ?? []) }));
        } catch (error) {
          logger.warn('Background session load threw, row keeps host status word', {
            sessionId,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          if (active) setOutcomes((prev) => ({ ...prev, [sessionId]: undefined }));
        }
      })();
    }
    return () => { active = false; };
  }, [pending]);

  return outcomes;
}
