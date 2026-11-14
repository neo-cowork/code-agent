import { beforeEach, describe, expect, it, vi } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import type { Session } from '../../src/shared/contract';
import { detectInternalTextLeaks } from '../../src/shared/internalTextLeakDetect';

const state = vi.hoisted(() => ({ language: 'en' as 'zh' | 'en', writes: [] as Array<{ sql: string; args: unknown[] }> }));
const database = {
  prepare: (sql: string) => ({
    get: () => undefined,
    all: () => [],
    run: (...args: unknown[]) => { state.writes.push({ sql, args }); return { changes: 1 }; },
  }),
  transaction: (fn: () => void) => fn,
};
vi.mock('../../src/host/session/sessionTitleHostPrompt', () => ({ readUiLanguage: () => state.language }));
vi.mock('../../src/host/services/core/databaseService', () => ({ getDatabase: () => ({ getDb: () => database }) }));
import { SessionRepository } from '../../src/host/services/core/repositories/SessionRepository';
import { createBackgroundTaskLedger } from '../../src/host/task/backgroundTaskLedger';
import { createTask as createSessionTask } from '../../src/host/services/planning/taskStore';
import { TaskListManager } from '../../src/host/agent/taskList';
import { sanitizeNotificationText } from '../../src/host/services/infra/notificationPolicy';
import { saveCronJob } from '../../src/host/cron/cronPersistence';
import type { CronJobDefinition } from '../../src/shared/contract/cron';

beforeEach(() => { state.writes = []; });
describe('humanized names at host persistence boundaries', () => {
  it.each(['zh', 'en'] as const)('stores clean session, task and cron names in %s', async (lang) => {
    state.language = lang;
    const raw = 'read_file call_report123';
    const repo = new SessionRepository(database as unknown as BetterSqlite3.Database);
    const session: Session = { id: 'session_report123', title: raw, modelConfig: { provider: 'xiaomi', model: 'test-model' }, createdAt: 100, updatedAt: 200 };
    repo.createSession(session);
    repo.createSessionWithId('session_insert123', { title: raw, modelConfig: session.modelConfig, createdAt: 100, updatedAt: 200 });
    expect(detectInternalTextLeaks(session.title)).toEqual([]);
    const updates = { title: raw, updatedAt: 123 };
    repo.updateSession(session.id, updates);
    expect(detectInternalTextLeaks(updates.title)).toEqual([]);
    repo.updateSessionPlanTitle(session.id, raw, 456);
    const inserts = state.writes.filter((w) => w.sql.includes('INSERT INTO sessions'));
    expect(inserts).toHaveLength(2);
    for (const insert of inserts) expect(detectInternalTextLeaks(String(insert.args[2]))).toEqual([]);
    const update = state.writes.find((w) => w.sql.includes('SET title ='))!;
    expect(detectInternalTextLeaks(String(update.args[0]))).toEqual([]);
    expect(update.args[8]).toBe(123);
    const plan = state.writes.find((w) => w.sql.includes('SET plan_title'))!;
    expect(detectInternalTextLeaks(String(plan.args[0]))).toEqual([]);
    expect(plan.args[1]).toBe(456);
    const planningTask = createSessionTask(`planning-${lang}`, { subject: 'read_file', description: 'Read report' });
    expect(planningTask.subject).toBe(lang === 'en' ? 'Read file' : '读取文件');
    expect(planningTask.activeForm).toBe(planningTask.subject);
    const chineseTask = createSessionTask(`planning-${lang}`, { subject: '整理周报', description: '整理周报' });
    expect(chineseTask.activeForm).toBe('整理周报');
    const manager = new TaskListManager();
    const task = manager.createTask({ subject: raw, description: 'Export table' });
    expect(detectInternalTextLeaks(task.subject)).toEqual([]);
    expect(detectInternalTextLeaks(manager.updateTask(task.id, { subject: raw })!.subject)).toEqual([]);
    const job: CronJobDefinition = { id: 'job-test', name: raw, scheduleType: 'every', schedule: { type: 'every', interval: 1, unit: 'hours' }, action: { type: 'shell', command: 'true' }, runsOn: 'local', enabled: true, createdAt: 100, updatedAt: 200 };
    await saveCronJob(job);
    const cron = state.writes.find((w) => w.sql.includes('INSERT INTO cron_jobs'))!;
    expect(detectInternalTextLeaks(String(cron.args[1]))).toEqual([]);
    expect(detectInternalTextLeaks(job.name)).toEqual([]);
  });

  it('notification text uses the shared layer before truncation and removes reply control tags', () => {
    state.language = 'en';
    const raw = '**Report ready** read_file call_export123 <decision>report</decision><rationale>Review it</rationale>';
    const text = sanitizeNotificationText(raw);
    expect(text).toContain('Report ready');
    expect(detectInternalTextLeaks(text)).toEqual([]);
    expect(text).not.toContain('<decision>');
    expect(text).not.toContain('Review it');
  });
  it('keeps background commands as execution data and uses plain titles and notices', () => {
    state.language = 'en';
    const ledger = createBackgroundTaskLedger();
    const command = 'python export.py';
    const task = ledger.upsertTask({ id: 'task-export', sessionId: 'session_export123', title: command, command });
    expect(task.title).toBe('Manage background tasks');
    expect(task.command).toBe(command);
    expect(ledger.upsertTask({ id: 'task-no-name', sessionId: 'session_export123' }).title).toBe('Manage background tasks');
    const notice = ledger.queueNotification({ taskId: task.id, type: 'task_completed', title: 'call_export123', message: 'read_file call_export123' });
    expect(detectInternalTextLeaks(notice.title ?? '')).toEqual([]);
    expect(detectInternalTextLeaks(notice.message)).toEqual([]);
    expect(notice.taskId).toBe(task.id);
    expect(notice.sessionId).toBe(task.sessionId);
  });

});
