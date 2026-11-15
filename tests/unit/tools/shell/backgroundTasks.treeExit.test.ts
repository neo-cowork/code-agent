// 走产品真路径（startBackgroundTask / killBackgroundTask）验收尸：
// 只测 killProcessTree 证明不了后台任务这一支——它还取决于 spawn 时有没有 detached 成组、
// 收树时有没有传 posixGroupKill。2026-07-30 孤儿 Chrome 事故坏的正是这两项。
// 证据档位：real-runtime。
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getAllBackgroundTasks,
  adoptBackgroundTask,
  getTaskOutput,
  cleanupTimedOutTasks,
  killBackgroundTask,
  onBackgroundTaskLifecycleEvent,
  startBackgroundTask,
} from '../../../../src/host/tools/shell/backgroundTasks';
import { BackgroundTaskLedger } from '../../../../src/host/task/backgroundTaskLedger';
import { installBackgroundTaskEventAdapters } from '../../../../src/host/task/backgroundTaskSnapshotAdapters';
import { shutdownEventBus } from '../../../../src/host/services/eventing/bus';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

posixOnly('后台任务停机收尸', () => {
  const startedTaskIds: string[] = [];

  afterEach(async () => {
    for (const taskId of startedTaskIds.splice(0)) {
      await killBackgroundTask(taskId).catch(() => undefined);
    }
  });

  it('自然退出后调用一次宿主清理回调', async () => {
    const cwd = mkdtempSync(`${tmpdir()}/neo-bgtask-`);
    const onExit = vi.fn();
    const started = startBackgroundTask('true', cwd, 30_000, { onExit });
    expect(started.success).toBe(true);
    startedTaskIds.push(started.taskId!);

    await waitFor(() => getAllBackgroundTasks().some(
      (task) => task.taskId === started.taskId && task.status === 'completed',
    ));

    expect(onExit).toHaveBeenCalledOnce();
  });

  it('adopts an existing child with buffered output and abort cleans it up', async () => {
    const cwd = mkdtempSync(`${tmpdir()}/neo-adopt-`);
    const ctrl = new AbortController();
    const child = spawn('bash', ['-c', 'for i in $(seq 1 20); do echo "line-$i"; sleep 0.1; done'], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    startedTaskIds.push('adopted-task-placeholder');
    let buffered = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child did not produce initial output')), 3000);
      const onData = (chunk: Buffer | string) => {
        buffered += chunk.toString();
        if (buffered.includes('line-1')) {
          clearTimeout(timer);
          child.stdout?.removeListener('data', onData);
          resolve();
        }
      };
      child.stdout?.on('data', onData);
      child.once('error', reject);
    });

    const adopted = adoptBackgroundTask(child, 'adopted shell', cwd, {
      abortSignal: ctrl.signal,
      bufferedStdout: buffered,
    });
    expect(adopted.success).toBe(true);
    expect(adopted.taskId).toBeTruthy();
    startedTaskIds.splice(startedTaskIds.indexOf('adopted-task-placeholder'), 1, adopted.taskId!);

    await waitFor(async () => (await getTaskOutput(adopted.taskId!))?.output.includes('line-3') === true);
    const output = await getTaskOutput(adopted.taskId!);
    expect(output?.output).toContain('line-1');
    expect(output?.output).toContain('line-3');

    ctrl.abort();
    await waitFor(() => getAllBackgroundTasks().find((task) => task.taskId === adopted.taskId)?.status !== 'running');
    expect(getAllBackgroundTasks().find((task) => task.taskId === adopted.taskId)?.status).toBe('failed');
  }, 15_000);

  it('kill 后台任务时，它 spawn 出来的孙进程一起死干净', async () => {
    const cwd = mkdtempSync(`${tmpdir()}/neo-bgtask-`);
    // 孙进程把自己的 pid 写到文件里——这就是「跑 e2e 脚本的后台任务拉起 Playwright worker」
    // 的最小形状。旧实现只杀 bash，这个 sleep 会被 init 收养继续活着。
    const pidFile = `${cwd}/grandchild.pid`;
    const onExit = vi.fn();
    const started = startBackgroundTask(
      `sleep 120 & echo $! > ${pidFile}; wait`,
      cwd,
      30_000,
      { onExit },
    );
    expect(started.success).toBe(true);
    startedTaskIds.push(started.taskId!);

    const { readFileSync, existsSync } = await import('fs');
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf-8').trim().length > 0);
    const grandchildPid = Number(readFileSync(pidFile, 'utf-8').trim());
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(pidAlive(grandchildPid)).toBe(true);

    const result = await killBackgroundTask(started.taskId!);

    expect(result.success).toBe(true);
    // 承重断言：killBackgroundTask 返回时孙进程必须已经死了，不能是「信号发出去了」
    expect(pidAlive(grandchildPid)).toBe(false);
    expect(getAllBackgroundTasks().find((t) => t.taskId === started.taskId)?.status).not.toBe('running');
    expect(onExit).toHaveBeenCalledOnce();
  }, 30000);

  it('reapChildProcesses 收掉全部在跑的后台任务（停机属主调的就是它）', async () => {
    const cwd = mkdtempSync(`${tmpdir()}/neo-bgtask-`);
    const started = startBackgroundTask('sleep 120', cwd);
    expect(started.success).toBe(true);
    startedTaskIds.push(started.taskId!);
    await waitFor(() => getAllBackgroundTasks().some(
      (t) => t.taskId === started.taskId && t.status === 'running',
    ));

    const { reapChildProcesses } = await import('../../../../src/host/tools/shell/shutdownReaper');
    const { killedTasks } = await reapChildProcesses('test_shutdown');

    expect(killedTasks).toBeGreaterThanOrEqual(1);
    expect(getAllBackgroundTasks().some((t) => t.status === 'running')).toBe(false);
  }, 30000);

  it('records stopped background task as cancelled with one task_cancelled notice before process exit fires failed', async () => {
    const cwd = mkdtempSync(`${tmpdir()}/neo-bgtask-`);
    const ledger = new BackgroundTaskLedger();
    const detach = installBackgroundTaskEventAdapters(ledger);
    try {
      const started = startBackgroundTask(
        'sandbox-exec-placeholder || sleep 600 && echo done',
        cwd,
        30_000,
        {
          sessionId: 'session-stop-real',
          displayCommand: 'sleep 600 && echo done',
        },
      );
      expect(started.success).toBe(true);
      startedTaskIds.push(started.taskId!);

      await waitFor(() => ledger.getTask(`shell:${started.taskId}`)?.status === 'running');

      const killResult = await killBackgroundTask(started.taskId!);
      expect(killResult.success).toBe(true);

      const ledgerTask = ledger.getTask(`shell:${started.taskId}`);
      expect(ledgerTask).toMatchObject({
        status: 'cancelled',
        title: 'sleep',
        failure: undefined,
      });

      const notifications = ledger.drainNotifications('session-stop-real');
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        type: 'task_cancelled',
        title: '任务已停止',
      });
      expect(notifications[0]?.message).toContain('sleep 已停止');
      expect(notifications[0]?.message).not.toContain('sandbox-exec');
      expect(notifications[0]?.message).not.toContain('失败');
      expect(notifications.some((n) => n.type === 'task_failed')).toBe(false);
    } finally {
      detach();
      shutdownEventBus();
    }
  }, 30000);

  it('keeps non-zero exit command as failed with task_failed notice', async () => {
    const cwd = mkdtempSync(`${tmpdir()}/neo-bgtask-`);
    const ledger = new BackgroundTaskLedger();
    const detach = installBackgroundTaskEventAdapters(ledger);
    try {
      const started = startBackgroundTask(
        'echo boom && exit 7',
        cwd,
        30_000,
        {
          sessionId: 'session-fail-real',
          displayCommand: 'echo boom && exit 7',
        },
      );
      expect(started.success).toBe(true);
      startedTaskIds.push(started.taskId!);

      await waitFor(() => ledger.getTask(`shell:${started.taskId}`)?.status === 'failed');

      const ledgerTask = ledger.getTask(`shell:${started.taskId}`);
      expect(ledgerTask).toMatchObject({
        status: 'failed',
        title: 'exit',
        failure: {
          message: 'Process exited with code 7',
          exitCode: 7,
          category: 'command_failed',
        },
      });

      const notifications = ledger.drainNotifications('session-fail-real');
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        type: 'task_failed',
        title: '后台任务失败',
      });
    } finally {
      detach();
      shutdownEventBus();
    }
  }, 30000);

  it('task over max runtime reaped by the timeout sweep stays failed with task_failed (not cancelled)', async () => {
    const cwd = mkdtempSync(`${tmpdir()}/neo-bgtask-`);
    const ledger = new BackgroundTaskLedger();
    const detach = installBackgroundTaskEventAdapters(ledger);
    try {
      const started = startBackgroundTask('sleep 600', cwd, 30_000, {
        sessionId: 'session-timeout-real',
        displayCommand: 'sleep 600',
      });
      expect(started.success).toBe(true);
      startedTaskIds.push(started.taskId!);
      await waitFor(() => ledger.getTask(`shell:${started.taskId}`)?.status === 'running');

      // 把时钟拨过 maxRuntime，让周期清扫（而非 setTimeout 句柄）认定超时。
      const realNow = Date.now();
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 31_000);
      try {
        cleanupTimedOutTasks();
      } finally {
        nowSpy.mockRestore();
      }
      await waitFor(() => ledger.getTask(`shell:${started.taskId}`)?.status === 'failed', 15_000);

      expect(ledger.getTask(`shell:${started.taskId}`)?.status).toBe('failed');
      const notifications = ledger.drainNotifications('session-timeout-real');
      expect(notifications.map((n) => n.type)).toEqual(['task_failed']);
    } finally {
      detach();
      shutdownEventBus();
    }
  }, 30000);

  it('kill on an already completed task keeps it completed with only the task_completed notice', async () => {
    const cwd = mkdtempSync(`${tmpdir()}/neo-bgtask-`);
    const ledger = new BackgroundTaskLedger();
    const detach = installBackgroundTaskEventAdapters(ledger);
    try {
      const started = startBackgroundTask('echo finished-ok', cwd, 30_000, {
        sessionId: 'session-kill-done',
        displayCommand: 'echo finished-ok',
      });
      expect(started.success).toBe(true);
      startedTaskIds.push(started.taskId!);
      await waitFor(() => ledger.getTask(`shell:${started.taskId}`)?.status === 'completed', 20_000);

      const killResult = await killBackgroundTask(started.taskId!);
      expect(killResult.success).toBe(true);
      await new Promise((resolve) => { setTimeout(resolve, 200); });

      expect(ledger.getTask(`shell:${started.taskId}`)?.status).toBe('completed');
      expect(getAllBackgroundTasks().find((t) => t.taskId === started.taskId)?.status).toBe('completed');
      const notifications = ledger.drainNotifications('session-kill-done');
      expect(notifications.map((n) => n.type)).toEqual(['task_completed']);
    } finally {
      detach();
      shutdownEventBus();
    }
  }, 30000);

  it('killing a running task emits exactly one terminal lifecycle event and one task_cancelled notice', async () => {
    const cwd = mkdtempSync(`${tmpdir()}/neo-bgtask-`);
    const ledger = new BackgroundTaskLedger();
    const detach = installBackgroundTaskEventAdapters(ledger);
    const terminalEvents: string[] = [];
    let taskIdUnderTest = '';
    const stopListening = onBackgroundTaskLifecycleEvent((event) => {
      if (event.task.taskId === taskIdUnderTest && event.type !== 'started') terminalEvents.push(event.type);
    });
    try {
      const started = startBackgroundTask('sleep 30', cwd, 60_000, {
        sessionId: 'session-single-terminal',
        displayCommand: 'sleep 30',
      });
      expect(started.success).toBe(true);
      taskIdUnderTest = started.taskId!;
      startedTaskIds.push(started.taskId!);
      await waitFor(() => ledger.getTask(`shell:${started.taskId}`)?.status === 'running');

      expect((await killBackgroundTask(started.taskId!)).success).toBe(true);
      // 等进程 close 事件也走完，再留一小段沉淀期，确认没有第二条终态事件。
      await new Promise((resolve) => { setTimeout(resolve, 500); });

      expect(terminalEvents).toHaveLength(1);
      expect(ledger.getTask(`shell:${started.taskId}`)?.status).toBe('cancelled');
      const notifications = ledger.drainNotifications('session-single-terminal');
      expect(notifications.map((n) => n.type)).toEqual(['task_cancelled']);
    } finally {
      stopListening();
      detach();
      shutdownEventBus();
    }
  }, 30000);

  it('output still arriving after kill does not write to the already ended log stream', async () => {
    const cwd = mkdtempSync(`${tmpdir()}/neo-bgtask-`);
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown) => { unhandled.push(error); };
    process.on('uncaughtException', onUncaught);
    try {
      // 持续刷输出的任务：kill 先 end() 了日志流，进程树退出前还会有输出落在流关闭之后。
      const started = startBackgroundTask(
        'trap "" TERM; while :; do echo flood; done',
        cwd,
        60_000,
        { sessionId: 'session-late-output' },
      );
      expect(started.success).toBe(true);
      startedTaskIds.push(started.taskId!);
      await new Promise((resolve) => { setTimeout(resolve, 200); });

      expect((await killBackgroundTask(started.taskId!)).success).toBe(true);
      await new Promise((resolve) => { setTimeout(resolve, 300); });

      expect(unhandled.map(String)).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  }, 30000);
});
