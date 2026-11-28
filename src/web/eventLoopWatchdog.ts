// ── Event loop stall watchdog ───────────────────────────────────────
// 2026-08-08 role e2e 排查留下的取证钩子：那次失败运行里 webServer **整整 36 秒零日志
// 输出**，且 MCP 的 30s 超时定时器晚了约 7 秒才打出来——典型的事件循环被堵住，而当时
// 什么都没记下来，只能靠"日志静默"这种间接证据推断。这里只**报告**不修复：
// 停顿超过阈值就打一行，正常情况下完全静音。
// 2026-11-26 夜跑：SkillWatcher 切目录时 FSWatcher.close() 在主线程同步等 fseventsd，
// 一次几十秒直至永久卡死。警告行里因此带上 SkillWatcher 最近操作与 LSP 状态（见
// loopBreadcrumbs），一眼看出是谁堵的。
// 关：CODE_AGENT_LOOP_WATCHDOG=0；阈值：CODE_AGENT_LOOP_WATCHDOG_MS；窗口：CODE_AGENT_LOOP_WATCHDOG_WINDOW_MS。
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { EVENT_LOOP_DIAG_TIMEOUTS } from '../shared/constants';
import { createLogger } from '../host/services/infra/logger';
import { snapshotLoopBreadcrumbs } from '../host/services/infra/loopBreadcrumbs';

const logger = createLogger('EventLoopWatchdog');

export function startEventLoopWatchdog(): void {
  if (process.env.CODE_AGENT_LOOP_WATCHDOG === '0') return;
  const thresholdMs = Number(process.env.CODE_AGENT_LOOP_WATCHDOG_MS) || EVENT_LOOP_DIAG_TIMEOUTS.STALL_THRESHOLD;
  const windowMs = Number(process.env.CODE_AGENT_LOOP_WATCHDOG_WINDOW_MS) || EVENT_LOOP_DIAG_TIMEOUTS.WINDOW;
  const histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_DIAG_TIMEOUTS.SAMPLE_RESOLUTION });
  histogram.enable();
  const timer = setInterval(() => {
    const maxMs = histogram.max / 1e6;   // 纳秒 → 毫秒
    if (maxMs >= thresholdMs) {
      logger.warn('[loop-watchdog] event loop stalled', {
        max_ms: +maxMs.toFixed(1),
        mean_ms: +(histogram.mean / 1e6).toFixed(1),
        p99_ms: +(histogram.percentile(99) / 1e6).toFixed(1),
        window_s: windowMs / 1000,
        ...snapshotLoopBreadcrumbs(windowMs + maxMs),
      });
    }
    histogram.reset();
  }, windowMs);
  timer.unref();   // 别因为它拖着进程不退出
}
