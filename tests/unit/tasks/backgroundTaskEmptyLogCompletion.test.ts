import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BackgroundTaskLedger } from '../../../src/host/task/backgroundTaskLedger';
import { syncShellTaskSnapshotToLedger } from '../../../src/host/task/backgroundTaskSnapshotAdapters';

// Exit precedes the asynchronous log stream flush; an empty file cannot undo exit 0.
describe('shell completion before log flush', () => {
  it('keeps completed exit-0 snapshots completed and queues no task_failed notification', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'shell-unflushed-log-'));
    try {
      const outputFile = path.join(dir, 'task.log');
      await writeFile(outputFile, '');
      const ledger = new BackgroundTaskLedger();
      const task = {
        taskId: 'unflushed', sessionId: 'empty-log-session', command: 'true', cwd: '/repo',
        startTime: 1000, duration: 100, outputFile,
      };
      syncShellTaskSnapshotToLedger({ ...task, status: 'running' }, ledger);
      expect(await readFile(outputFile, 'utf8')).toBe('');
      syncShellTaskSnapshotToLedger({ ...task, status: 'completed', endTime: 1100, exitCode: 0 }, ledger);
      syncShellTaskSnapshotToLedger({ ...task, status: 'completed', endTime: 1100, exitCode: 0 }, ledger);
      expect(ledger.getTask('shell:unflushed')).toMatchObject({ status: 'completed', failure: undefined });
      const notifications = ledger.drainNotifications('empty-log-session');
      expect(notifications).toEqual([expect.objectContaining({ type: 'task_completed', taskId: 'shell:unflushed' })]);
      expect(notifications.some(({ type }) => type === 'task_failed')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
