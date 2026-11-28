import { useEffect, useState } from 'react';
import type { RendererBundleStatus, UpdateInfo } from '@shared/contract';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { createLogger } from '../utils/logger';
import { isOptionalUpdateAvailable } from '../utils/updatePrompt';

const logger = createLogger('useInterfaceUpdateNeedsUpgrade');

/** 热更新拒收原因里，只有这两种是「装新版 app 就能解决」的。 */
const UPGRADE_FIXES_REASONS = new Set(['shell-too-old', 'missing-shell-capability']);

function isRefusedUntilUpgrade(status: RendererBundleStatus, currentVersion: string): boolean {
  const attempt = status.lastAttempt;
  if (status.disabled || attempt?.outcome !== 'skipped') return false;
  if (!attempt.reason || !UPGRADE_FIXES_REASONS.has(attempt.reason)) return false;
  // 升级前留下的旧记录不算数：两边版本号都有时必须对得上
  return !attempt.currentShellVersion || !currentVersion || attempt.currentShellVersion === currentVersion;
}

/**
 * 侧栏「更新可用」入口可见时，读一次最近一次界面热更新结果（复用现有 rendererBundleStatus 通道）。
 * true = 这版 app 太旧，界面更新被拒收，升级后才能收到。
 */
export function useInterfaceUpdateNeedsUpgrade(updateInfo: UpdateInfo | null | undefined): boolean {
  // 记住结论是针对哪一份 updateInfo 得出的，换了一份就先归零，不沿用旧结论
  const [refusedFor, setRefusedFor] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    if (!updateInfo || !isOptionalUpdateAvailable(updateInfo)) return undefined;
    let cancelled = false;
    const read = async () => {
      try {
        const status = await ipcService.invokeDomain<RendererBundleStatus>(IPC_DOMAINS.UPDATE, 'rendererBundleStatus');
        if (!cancelled) setRefusedFor(isRefusedUntilUpgrade(status, updateInfo.currentVersion) ? updateInfo : null);
      } catch (error) {
        logger.debug('Renderer bundle status unavailable', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!cancelled) setRefusedFor(null);
      }
    };
    void read();
    return () => {
      cancelled = true;
    };
  }, [updateInfo]);

  return refusedFor !== null && refusedFor === updateInfo;
}
