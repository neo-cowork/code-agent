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

  it.each(['zh', 'en'] as const)('drops pasted ids from stored names without leaving a placeholder word or empty brackets in %s', (lang) => {
    state.language = lang;
    const repo = new SessionRepository(database as unknown as BetterSqlite3.Database);
    const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    for (const [raw, clean] of [
      [`周五周报提醒（工单 ${uuid}）`, '周五周报提醒'],
      [`Weekly report ${uuid}`, 'Weekly report'],
      [`整理本周周报 ${uuid}`, '整理本周周报'],
      [`Weekly report (ticket ${uuid}) for finance`, 'Weekly report for finance'],
      [`跟进 session_1794668704195_a9f9bc4e 的导出`, '跟进 的导出'],
      [`Export [call_9f8e7d6c5b4a3f2e1d0c] - sales table`, 'Export - sales table'],
      [`${uuid} - Weekly report`, 'Weekly report'],
      ['周五周报提醒（财务）', '周五周报提醒（财务）'],
    ] as const) {
      state.writes = [];
      const session: Session = { id: 'session_names123', title: raw, modelConfig: { provider: 'xiaomi', model: 'test-model' }, createdAt: 100, updatedAt: 200 };
      repo.createSession(session);
      expect(session.title).toBe(clean);
      expect(String(state.writes.find((w) => w.sql.includes('INSERT INTO sessions'))!.args[2])).toBe(clean);
      expect(session.title).not.toMatch(/内部记录|internal record|[（(]\s*[）)]/i);
    }
    const onlyId: Session = { id: 'session_names456', title: uuid, modelConfig: { provider: 'xiaomi', model: 'test-model' }, createdAt: 100, updatedAt: 200 };
    repo.createSession(onlyId);
    expect(onlyId.title.trim().length).toBeGreaterThan(0);
    expect(detectInternalTextLeaks(onlyId.title)).toEqual([]);
  });

  it.each(['zh', 'en'] as const)('stores a channel session name without the chat id or a placeholder suffix in %s', (lang) => {
    state.language = lang;
    const repo = new SessionRepository(database as unknown as BetterSqlite3.Database);
    for (const chatId of ['7e35d853-b2b1-4e85-8c37-849adbf3dddf', 'oc_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d']) {
      state.writes = [];
      const session: Session = { id: 'session_channel123', title: `[Channel] 客服收件箱 · ${chatId}`, modelConfig: { provider: 'xiaomi', model: 'test-model' }, createdAt: 100, updatedAt: 200 };
      repo.createSession(session);
      const stored = String(state.writes.find((w) => w.sql.includes('INSERT INTO sessions'))!.args[2]);
      expect(stored).toBe('[Channel] 客服收件箱');
      expect(session.title).toBe('[Channel] 客服收件箱');
    }
    const named: Session = { id: 'session_channel456', title: '[Channel] 客服收件箱 · 售后一群', modelConfig: { provider: 'xiaomi', model: 'test-model' }, createdAt: 100, updatedAt: 200 };
    repo.createSession(named);
    expect(named.title).toBe('[Channel] 客服收件箱 · 售后一群');
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
  it.each(['zh', 'en'] as const)('keeps connector tool ids out of approval notices in %s', (lang) => {
    state.language = lang;
    const text = sanitizeNotificationText('mcp__mail__list_recent_emails: 请求执行权限');
    expect(text).not.toMatch(/mcp|list_recent_emails|maillist/i);
    expect(detectInternalTextLeaks(text)).toEqual([]);
    expect(text).toContain('请求执行权限');
    expect(sanitizeNotificationText('**Report ready** __done__ `weekly-report.md`')).toBe('Report ready done weekly-report.md');
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
