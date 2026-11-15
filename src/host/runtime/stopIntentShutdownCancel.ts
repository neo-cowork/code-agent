// ============================================================================
// stopIntentShutdownCancel — 「停止并退出」停机时按停止按钮同款路径取消在跑 run
// ============================================================================
// 背景：stop 意图停机原先走 60s 完整排空（daemonDrain），期间 run 不被取消，任务
// 继续调工具、写文件（真机实测 54-63s）。stop 的产品语义是「真停」，所以停机第一步
// 就对 registry 里每个 run 发 handle.cancel('user')（与停止按钮同一入口），再最多
// 等一个短宽限让 run 自己收口（orchestrator 的 finally 会 finalizeOrParkDurableRun
// 并 unregister），再补一次空闲浏览器清理。未收口的留给后续 reap → park → 关库。
// 非 stop 意图（none/background）不动任何 run，仍走原 60s 排空。
// ============================================================================

import type { RunRegistry } from './runRegistry';
import { WEB_DAEMON } from '../../shared/constants/webServer';
import { getDaemonQuitIntent } from '../services/daemon/quitIntent';
import { closeIdleManagedBrowsers } from '../services/infra/browser/closeIdleManagedBrowsers';

export interface StopIntentShutdownCancelSummary {
  intent: string;
  cancelled: number;
  /** 宽限结束时仍在 registry 里的 run 数。 */
  remaining: number;
}

export async function cancelRunsOnStopIntentShutdown(
  registry: RunRegistry,
  opts: {
    graceMs?: number;
    pollIntervalMs?: number;
    log?: (message: string) => void;
    /** 壳的强杀看门狗是否还悬着（isDrainWatchdogActive）：在则宽限压到 1s 并套 withCap，给关库留预算。 */
    watchdogActive?: boolean;
    withCap?: <T>(p: Promise<T>, label: string) => Promise<T | void>;
  } = {},
): Promise<StopIntentShutdownCancelSummary> {
  const intent = getDaemonQuitIntent();
  const summary: StopIntentShutdownCancelSummary = { intent, cancelled: 0, remaining: registry.size };
  if (intent !== 'stop') return summary;
  const log = opts.log ?? console.log;
  const graceMs = opts.graceMs ?? (opts.watchdogActive ? WEB_DAEMON.DRAIN_GRACE_UNDER_SHELL_MS : WEB_DAEMON.STOP_INTENT_CANCEL_GRACE_MS);
  const pollMs = opts.pollIntervalMs ?? WEB_DAEMON.POLL_INTERVAL_MS;

  const run = async (): Promise<void> => {
    for (const handle of registry.list()) {
      log(`[shutdown] stop-intent cancel: runId=${handle.context.runId}`);
      summary.cancelled += 1;
      // 不 await：cancel 的投递可能卡在目标上，宽限由下面的轮询统一封顶。
      handle.cancel('user').catch((error) => {
        log(`[shutdown] stop-intent cancel failed: runId=${handle.context.runId} error=${error instanceof Error ? error.message : String(error)}`);
      });
    }

    const deadline = Date.now() + graceMs;
    while (registry.size > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollMs).unref?.());
    }
    summary.remaining = registry.size;
    // shutdown 开头那次清理时 run 还占着浏览器（被跳过）；run 被取消后再清一次。
    closeIdleManagedBrowsers('shutdown');
    log(`[shutdown] stop-intent cancel summary: cancelled=${summary.cancelled} remaining=${summary.remaining}`);
  };
  // win32：stdin EOF 后 3s TerminateProcess，取消步骤绝不能吃穿关库预算（同 drainPendingOpsForShutdown）。
  if (opts.watchdogActive && opts.withCap) await opts.withCap(run(), 'stopIntent.cancel');
  else await run();
  return summary;
}
