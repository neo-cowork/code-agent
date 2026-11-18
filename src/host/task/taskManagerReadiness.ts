// TaskManager 依赖注入完成的就绪信号（N-FIX-CRON-START-ORCHESTRATOR-NOT-READY）。
// 启动期 cron 补跑早于 createAgentRuntime，调用方需要一个有上限的等待而不是立刻失败。

export class TaskManagerReadiness {
  private ready = false;
  private waiters = new Set<(ready: boolean) => void>();

  markReady(): void {
    this.ready = true;
    for (const resolve of this.waiters) resolve(true);
    this.waiters.clear();
  }

  /** 已就绪立即返回 true（不排微任务以外的等待）；超时返回 false。 */
  wait(timeoutMs: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const settle = (ready: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(settle);
        resolve(ready);
      };
      const timer = setTimeout(() => settle(false), timeoutMs);
      this.waiters.add(settle);
    });
  }
}
