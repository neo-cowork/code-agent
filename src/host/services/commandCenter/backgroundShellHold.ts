import type { ToolResult } from '../../../shared/contract/tool';
import { MCP_TIMEOUTS, SUBAGENT_COMPLETION_NOTIFICATIONS } from '../../../shared/constants/timeouts';
import {
  getBackgroundTask,
  onBackgroundTaskLifecycleEvent,
} from '../../tools/modules/shell/backgroundTaskSources';

/**
 * 委派任务的子 run 用 `Bash run_in_background` 起了后台命令、随后没再调任何工具就结束本轮时，
 * 子 run 的收尾话（「已启动，N 秒后…」）不是结论——结论在命令退出之后才有。
 * 判据是结构信号，不看措辞：子 run 自己起的后台 Bash 仍在跑 + 起它之后再无工具调用。
 * 起后台命令之后又 poll / curl / 读文件，说明子 run 已经在做实质收尾（dev server 形态），不挂起。
 */

export interface BackgroundShellHoldRelease {
  /** 命令退出后的摘要（含输出）；超时则是「仍在运行」说明。 */
  note: string;
  /** true = 命令已退出（note 即最终结果）；false = 到上限仍在运行。 */
  exited: boolean;
}

interface Pending {
  shellId: string;
  unsubscribe?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

function readLaunchedShellId(result: ToolResult): string | undefined {
  if (!result.success) return undefined;
  const meta = result.metadata;
  if (meta?.background !== true) return undefined;
  return typeof meta.taskId === 'string' && meta.taskId ? meta.taskId : undefined;
}

function tailOutput(output: string): string {
  const text = output.trim();
  const limit = SUBAGENT_COMPLETION_NOTIFICATIONS.INLINE_OUTPUT_LIMIT;
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

function describeExit(shellId: string, fallbackExitCode: number | undefined): string {
  const state = getBackgroundTask(shellId);
  const exitCode = state?.exitCode ?? fallbackExitCode;
  const output = tailOutput((state?.output ?? []).join(''));
  const head = exitCode === 0 || (exitCode === undefined && state?.status === 'completed')
    ? '后台命令已正常结束。'
    : `后台命令已结束，但没有成功完成（退出码 ${exitCode ?? '未知'}）。`;
  return output ? `${head}输出：${output}` : `${head}没有输出内容。`;
}

export class BackgroundShellHold {
  /** 每个任务最近一次「起后台命令之后还没有后续工具调用」的 shell id */
  private readonly trailingLaunchByTask = new Map<string, string>();
  private readonly pendingByTask = new Map<string, Pending>();

  noteToolCallEnd(taskId: string, result: ToolResult): void {
    const shellId = readLaunchedShellId(result);
    if (shellId) this.trailingLaunchByTask.set(taskId, shellId);
    else this.trailingLaunchByTask.delete(taskId);
  }

  isHeld(taskId: string): boolean {
    return this.pendingByTask.has(taskId);
  }

  /** 返回 true = 已挂起，onRelease 会在命令退出或到上限时调用一次；false = 应立即收尾。 */
  hold(taskId: string, onRelease: (release: BackgroundShellHoldRelease) => void): boolean {
    const shellId = this.trailingLaunchByTask.get(taskId);
    this.trailingLaunchByTask.delete(taskId);
    if (!shellId || getBackgroundTask(shellId)?.status !== 'running') return false;

    const pending: Pending = { shellId };
    const release = (note: string, exited: boolean): void => {
      if (this.pendingByTask.get(taskId) !== pending) return;
      this.drop(taskId);
      onRelease({ note, exited });
    };
    pending.unsubscribe = onBackgroundTaskLifecycleEvent((event) => {
      if (event.task.taskId !== shellId || event.type === 'started') return;
      release(describeExit(shellId, event.task.exitCode), true);
    });
    pending.timer = setTimeout(
      () => release('后台命令仍在运行，结果出来后不会再自动汇报；需要时请再查看它的输出。', false),
      MCP_TIMEOUTS.IDLE_REAP_TTL,
    );
    this.pendingByTask.set(taskId, pending);
    // 订阅前命令恰好已退出：补一次检查，避免永远等不到事件
    if (getBackgroundTask(shellId)?.status !== 'running') release(describeExit(shellId, undefined), true);
    return true;
  }

  drop(taskId: string): void {
    this.trailingLaunchByTask.delete(taskId);
    const pending = this.pendingByTask.get(taskId);
    if (!pending) return;
    this.pendingByTask.delete(taskId);
    pending.unsubscribe?.();
    if (pending.timer) clearTimeout(pending.timer);
  }

  dispose(): void {
    for (const taskId of [...this.pendingByTask.keys()]) this.drop(taskId);
    this.trailingLaunchByTask.clear();
  }
}
