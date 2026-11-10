import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllBackgroundTasks: vi.fn(),
  getAllPtySessions: vi.fn(),
  onBackgroundTaskLifecycleEvent: vi.fn((_listener: (event: BackgroundTaskLifecycleEvent) => void) => () => {}),
  onPtySessionLifecycleEvent: vi.fn((_listener: (event: PtySessionLifecycleEvent) => void) => () => {}),
}));

vi.unmock('better-sqlite3');

vi.mock('../../../src/host/tools/modules/shell/backgroundTaskSources', () => ({
  getAllBackgroundTasks: mocks.getAllBackgroundTasks,
  getAllPtySessions: mocks.getAllPtySessions,
  onBackgroundTaskLifecycleEvent: mocks.onBackgroundTaskLifecycleEvent,
  onPtySessionLifecycleEvent: mocks.onPtySessionLifecycleEvent,
}));

import Database from 'better-sqlite3';
import { BackgroundTaskLedger } from '../../../src/host/task/backgroundTaskLedger';
import { SqliteBackgroundTaskStore } from '../../../src/host/task/backgroundTaskStore';
import type { BackgroundTaskLedgerChangedData } from '../../../src/shared/contract/agent';
import { getEventBus, shutdownEventBus } from '../../../src/host/services/eventing/bus';
import {
  installBackgroundTaskEventAdapters,
  syncBackgroundTaskSnapshotsToLedger,
  syncShellTaskSnapshotToLedger,
  syncPtySessionSnapshotToLedger,
} from '../../../src/host/task/backgroundTaskSnapshotAdapters';
import type {
  BackgroundTaskLifecycleEvent,
  PtySessionLifecycleEvent,
} from '../../../src/host/tools/modules/shell/backgroundTaskSources';

describe('backgroundTaskSnapshotAdapters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
  });

  afterEach(() => {
    shutdownEventBus();
  });

  it('does not publish invalidations during pull-driven snapshot reconciliation', () => {
    mocks.getAllBackgroundTasks.mockReturnValue([{
      taskId: 'quiet-shell',
      status: 'running',
      command: 'npm run dev',
      cwd: '/repo',
      sessionId: 'session-quiet',
      startTime: 1_000,
      duration: 9_000,
      outputFile: '/tmp/quiet-shell.log',
    }]);
    mocks.getAllPtySessions.mockReturnValue([]);
    const invalidations: BackgroundTaskLedgerChangedData[] = [];
    getEventBus().subscribe<BackgroundTaskLedgerChangedData>(
      'agent:background_task_ledger_changed',
      (event) => {
        invalidations.push(event.data);
      },
    );
    const ledger = new BackgroundTaskLedger();

    ledger.runQuiet(() => {
      syncBackgroundTaskSnapshotsToLedger(ledger);
      syncBackgroundTaskSnapshotsToLedger(ledger);
    });

    expect(ledger.getTask('shell:quiet-shell')).toMatchObject({ status: 'running' });
    expect(invalidations).toEqual([]);
  });

  it('maps shell and pty snapshots into ledger tasks with stable log refs', () => {
    mocks.getAllBackgroundTasks.mockReturnValue([
      {
        taskId: 'shell-1',
        status: 'failed',
        command: 'npm test',
        cwd: '/repo',
        sessionId: 'session-1',
        toolCallId: 'tool-1',
        startTime: 1_000,
        endTime: 2_500,
        duration: 1_500,
        exitCode: 1,
        outputFile: '/tmp/shell-1.log',
      },
    ]);
    mocks.getAllPtySessions.mockReturnValue([
      {
        sessionId: 'pty-1',
        status: 'running',
        command: 'bash',
        args: ['-lc', 'npm run dev'],
        cwd: '/repo',
        ownerSessionId: 'session-1',
        toolCallId: 'tool-2',
        startTime: 3_000,
        duration: 7_000,
        outputFile: '/tmp/pty-1.log',
        cols: 120,
        rows: 30,
      },
    ]);

    const ledger = new BackgroundTaskLedger();
    syncBackgroundTaskSnapshotsToLedger(ledger);
    syncBackgroundTaskSnapshotsToLedger(ledger);

    const shellTask = ledger.getTask('shell:shell-1');
    expect(shellTask).toMatchObject({
      kind: 'shell',
      source: 'shell',
      title: 'npm test',
      status: 'failed',
      command: 'npm test',
      cwd: '/repo',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      completedAt: 2_500,
      durationMs: 1_500,
      failure: {
        message: 'Process exited with code 1',
        exitCode: 1,
        category: 'command_failed',
      },
    });
    expect(shellTask?.outputRefs).toEqual([
      expect.objectContaining({
        id: 'shell:shell-1:log',
        type: 'log',
        path: '/tmp/shell-1.log',
      }),
    ]);

    const ptyTask = ledger.getTask('pty:pty-1');
    expect(ptyTask).toMatchObject({
      kind: 'pty',
      source: 'pty',
      title: 'bash -lc npm run dev',
      status: 'running',
      command: 'bash -lc npm run dev',
      cwd: '/repo',
      sessionId: 'session-1',
      toolCallId: 'tool-2',
      startedAt: 3_000,
      updatedAt: 10_000,
      durationMs: 7_000,
      metadata: expect.objectContaining({
        createdBy: 'neo',
        recoveryStatus: 'running-live',
        recoveryPlan: expect.objectContaining({
          status: 'running-live',
          recoverable: true,
          controlActions: ['poll', 'open_log', 'kill'],
        }),
      }),
    });
    expect(ptyTask?.outputRefs).toEqual([
      expect.objectContaining({
        id: 'pty:pty-1:log',
        type: 'log',
        path: '/tmp/pty-1.log',
      }),
    ]);

    const notifications = ledger.drainNotifications('session-1');
    expect(notifications).toEqual([
      expect.objectContaining({
        id: 'shell:shell-1:terminal:failed',
        taskId: 'shell:shell-1',
        type: 'task_failed',
        message: expect.stringContaining('npm test 失败'),
      }),
    ]);
    expect(ledger.drainNotifications('session-1')).toEqual([]);
  });

  it('maps stopped shell snapshots to cancelled with displayCommand and task_cancelled notification', () => {
    mocks.getAllBackgroundTasks.mockReturnValue([
      {
        taskId: 'shell-stopped',
        status: 'failed',
        stoppedByRequest: true,
        command: 'sandbox-exec -f /tmp/profile.sb /bin/sh -c "sleep 600 && echo done"',
        displayCommand: 'sleep 600 && echo done',
        cwd: '/repo',
        sessionId: 'session-stop',
        toolCallId: 'tool-stop',
        startTime: 1_000,
        endTime: 1_500,
        duration: 500,
        outputFile: '/tmp/shell-stopped.log',
      },
    ]);
    mocks.getAllPtySessions.mockReturnValue([]);

    const ledger = new BackgroundTaskLedger();
    syncBackgroundTaskSnapshotsToLedger(ledger);
    syncBackgroundTaskSnapshotsToLedger(ledger);

    const shellTask = ledger.getTask('shell:shell-stopped');
    expect(shellTask).toMatchObject({
      kind: 'shell',
      source: 'shell',
      title: 'sleep 600 && echo done',
      status: 'cancelled',
      command: 'sandbox-exec -f /tmp/profile.sb /bin/sh -c "sleep 600 && echo done"',
      sessionId: 'session-stop',
      toolCallId: 'tool-stop',
      completedAt: 1_500,
      durationMs: 500,
      failure: undefined,
    });

    const notifications = ledger.drainNotifications('session-stop');
    expect(notifications).toEqual([
      expect.objectContaining({
        id: 'shell:shell-stopped:terminal:cancelled',
        taskId: 'shell:shell-stopped',
        type: 'task_cancelled',
        title: '任务已停止',
        message: 'sleep 600 && echo done 已停止，耗时 不到 1 秒',
      }),
    ]);
    expect(notifications[0]?.message).not.toContain('sandbox-exec');
    expect(notifications[0]?.message).not.toContain('失败');
    expect(notifications[0]?.message).not.toContain('退出码');
  });

  it('maps completed shell and pty snapshots with empty output to completed', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'background-empty-output-'));
    try {
      const emptyShellLog = path.join(tempDir, 'empty-shell.log');
      const emptyPtyLog = path.join(tempDir, 'empty-pty.log');
      const nonEmptyShellLog = path.join(tempDir, 'non-empty-shell.log');
      await writeFile(emptyShellLog, '', 'utf8');
      await writeFile(emptyPtyLog, '', 'utf8');
      await writeFile(nonEmptyShellLog, 'completed\n', 'utf8');

      mocks.getAllBackgroundTasks.mockReturnValue([
        {
          taskId: 'empty-shell',
          status: 'completed',
          command: 'true',
          cwd: '/repo',
          startTime: 1_000,
          endTime: 1_100,
          duration: 100,
          exitCode: 0,
          outputFile: emptyShellLog,
        },
        {
          taskId: 'non-empty-shell',
          status: 'completed',
          command: 'printf completed',
          cwd: '/repo',
          startTime: 2_000,
          endTime: 2_100,
          duration: 100,
          exitCode: 0,
          outputFile: nonEmptyShellLog,
        },
      ]);
      mocks.getAllPtySessions.mockReturnValue([
        {
          sessionId: 'empty-pty',
          status: 'completed',
          command: 'true',
          args: [],
          cwd: '/repo',
          startTime: 3_000,
          endTime: 3_100,
          duration: 100,
          exitCode: 0,
          outputFile: emptyPtyLog,
          cols: 120,
          rows: 30,
        },
      ]);

      const ledger = new BackgroundTaskLedger();
      syncBackgroundTaskSnapshotsToLedger(ledger);

      expect(ledger.getTask('shell:empty-shell')).toMatchObject({
        status: 'completed',
        failure: undefined,
        outputRefs: [expect.objectContaining({ size: 0 })],
      });
      expect(ledger.getTask('pty:empty-pty')).toMatchObject({
        status: 'completed',
        failure: undefined,
        outputRefs: [expect.objectContaining({ size: 0 })],
      });
      expect(ledger.getTask('shell:non-empty-shell')).toMatchObject({
        status: 'completed',
        failure: undefined,
        outputRefs: [expect.objectContaining({ size: 10 })],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    { status: 'completed' as const, exitCode: 0, stoppedByRequest: false, expected: 'completed' },
    { status: 'failed' as const, exitCode: 3, stoppedByRequest: false, expected: 'failed' },
    { status: 'failed' as const, exitCode: undefined, stoppedByRequest: true, expected: 'cancelled' },
  ])('public snapshot entries preserve $expected with missing logs', ({ status, exitCode, stoppedByRequest, expected }) => {
    const ledger = new BackgroundTaskLedger();
    const shared = { status, exitCode, stoppedByRequest, command: 'true', cwd: '/repo', startTime: 1_000, duration: 100 };
    syncShellTaskSnapshotToLedger({ ...shared, taskId: 'missing-shell', outputFile: '/missing/shell.log' }, ledger);
    syncPtySessionSnapshotToLedger({
      ...shared, sessionId: 'missing-pty', args: [], cols: 80, rows: 24, outputFile: '',
    }, ledger);

    for (const id of ['shell:missing-shell', 'pty:missing-pty']) {
      expect(ledger.getTask(id)?.status).toBe(expected);
      expect(ledger.getTask(id)?.failure).toEqual(expected === 'failed'
        ? { message: 'Process exited with code 3', exitCode: 3, category: 'command_failed' }
        : undefined);
      expect(ledger.getTask(id)?.outputRefs[0]?.size).toBeUndefined();
    }
  });

  it('installs lifecycle event adapters once and updates ledger from shell events', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'background-lifecycle-'));
    const outputFile = path.join(tempDir, 'event-shell.log');
    await writeFile(outputFile, 'build complete\n', 'utf8');
    const ledger = new BackgroundTaskLedger();
    const invalidations: BackgroundTaskLedgerChangedData[] = [];
    getEventBus().subscribe<BackgroundTaskLedgerChangedData>(
      'agent:background_task_ledger_changed',
      (event) => {
        invalidations.push(event.data);
      },
    );
    const detach = installBackgroundTaskEventAdapters(ledger);
    try {
      installBackgroundTaskEventAdapters(ledger);

      expect(mocks.onBackgroundTaskLifecycleEvent).toHaveBeenCalledTimes(1);
      expect(mocks.onPtySessionLifecycleEvent).toHaveBeenCalledTimes(1);

      const shellListener = mocks.onBackgroundTaskLifecycleEvent.mock.calls[0][0];
      shellListener({
        type: 'started',
        task: {
          taskId: 'event-shell',
          status: 'running',
          command: 'npm run build',
          cwd: '/repo',
          sessionId: 'session-event',
          toolCallId: 'tool-event',
          startTime: 4_000,
          duration: 0,
          outputFile,
        },
      });
      shellListener({
        type: 'completed',
        task: {
          taskId: 'event-shell',
          status: 'completed',
          command: 'npm run build',
          cwd: '/repo',
          sessionId: 'session-event',
          toolCallId: 'tool-event',
          startTime: 4_000,
          endTime: 5_500,
          duration: 1_500,
          exitCode: 0,
          outputFile,
        },
      });

      expect(ledger.getTask('shell:event-shell')).toMatchObject({
        status: 'completed',
        sessionId: 'session-event',
        toolCallId: 'tool-event',
        completedAt: 5_500,
      });
      expect(ledger.drainNotifications('session-event')).toEqual([
        expect.objectContaining({
          id: 'shell:event-shell:terminal:completed',
          type: 'task_completed',
        }),
      ]);
      expect(invalidations).toContainEqual({
        taskId: 'shell:event-shell',
        sessionId: 'session-event',
      });

    } finally {
      detach();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reloads persisted running shell tasks with explicit recovery status', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'background-recovery-'));
    const db = new Database(':memory:');
    try {
      const liveLog = path.join(tempDir, 'live.log');
      const deadLog = path.join(tempDir, 'dead.log');
      await writeFile(liveLog, 'live output\n', 'utf8');
      await writeFile(deadLog, 'dead output\n', 'utf8');

      const store = new SqliteBackgroundTaskStore(db);
      store.upsertTask({
        id: 'shell:live',
        kind: 'shell',
        sessionId: 'session-live',
        source: 'shell',
        title: 'npm run dev',
        command: 'npm run dev',
        status: 'running',
        createdAt: 100,
        updatedAt: 150,
        startedAt: 100,
        metadata: {
          createdBy: 'neo',
          pid: process.pid,
        },
        events: [],
        outputRefs: [{
          id: 'shell:live:log',
          taskId: 'shell:live',
          type: 'log',
          path: liveLog,
          createdAt: 100,
        }],
      });
      store.upsertTask({
        id: 'shell:dead',
        kind: 'shell',
        sessionId: 'session-dead',
        source: 'shell',
        title: 'npm run old-dev',
        command: 'npm run old-dev',
        status: 'running',
        createdAt: 200,
        updatedAt: 250,
        startedAt: 200,
        metadata: {
          createdBy: 'neo',
        },
        events: [],
        outputRefs: [{
          id: 'shell:dead:log',
          taskId: 'shell:dead',
          type: 'log',
          path: deadLog,
          createdAt: 200,
        }],
      });

      expect(store.loadTerminalTask('shell:live')).toMatchObject({
        status: 'running',
        metadata: expect.objectContaining({
          recoveryStatus: 'running-recovered',
          recoveryPlan: expect.objectContaining({
            status: 'running-recovered',
            recoverable: true,
            controlActions: ['poll', 'open_log', 'kill'],
          }),
        }),
      });
      expect(store.loadTerminalTask('shell:dead')).toMatchObject({
        status: 'orphaned',
        failure: expect.objectContaining({ category: 'dead_log_only' }),
        metadata: expect.objectContaining({
          recoveryStatus: 'dead-log-only',
          recoveryPlan: expect.objectContaining({
            status: 'dead-log-only',
            recoverable: false,
            controlActions: ['open_log', 'retry'],
          }),
        }),
      });
    } finally {
      db.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
