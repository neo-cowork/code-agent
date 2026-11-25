// ============================================================================
// N-FIX-CRON-RUN-ERROR-TRUST-RAW-ENGLISH-PATH：定时运行撞上项目文件夹信任失败时，
// cron_executions.error 只落稳定标记 PROJECT_SOURCE_TRUST:<kind>:<folderName>，
// 不落 ProjectSourceTrustError.message（英文句 + 本机绝对路径）。
// 两个落库点都覆盖：首次触发（executeJob catch）与退避重试（retryExecution catch）。
// ============================================================================
import { afterEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  executionRows: [] as Array<Record<string, unknown>>,
}));

const notifyState = vi.hoisted(() => ({
  notifyTaskComplete: vi.fn(),
}));

const CRON_EXECUTION_COLUMNS = [
  'id', 'job_id', 'session_id', 'status', 'scheduled_at', 'started_at',
  'completed_at', 'duration', 'result', 'error', 'retry_attempt', 'exit_code',
] as const;

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => ({
      prepare: (sql: string) => ({
        all: () => [],
        get: (...args: unknown[]) => (sql.includes('MAX(started_at)') ? { last_run_at: null, args } : undefined),
        run: (...args: unknown[]) => {
          if (sql.includes('INSERT OR REPLACE INTO cron_executions')) {
            const row: Record<string, unknown> = {};
            CRON_EXECUTION_COLUMNS.forEach((col, i) => { row[col] = args[i]; });
            const idx = dbState.executionRows.findIndex((r) => r.id === row.id);
            if (idx >= 0) dbState.executionRows[idx] = row; else dbState.executionRows.push(row);
          }
          return { changes: 1, lastInsertRowid: 0 };
        },
      }),
    }),
  }),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getSettings: () => ({ ui: { language: 'zh' } }),
  }),
}));

vi.mock('../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => ({
    recordCreated: vi.fn(async () => undefined),
    recordEvent: vi.fn(async () => undefined),
    getBySourceRef: vi.fn(() => null),
    upsert: vi.fn(() => undefined),
  }),
}));

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyTaskComplete: notifyState.notifyTaskComplete },
}));

import { CronService } from '../../../src/host/cron/cronService';
import { ProjectSourceTrustError } from '../../../src/host/services/project/projectSourceTrustError';
import type { ProjectSourceTrustFailureKind } from '../../../src/shared/contract/project';

afterEach(() => {
  vi.useRealTimers();
  dbState.executionRows = [];
  notifyState.notifyTaskComplete.mockClear();
});

type ExecuteActionPatch = () => Promise<unknown>;

/** 只替换 executeAction 这一层的结果：抛出的是真的 ProjectSourceTrustError，带 cronAgentAction 挂的会话 id。 */
function patchExecuteAction(service: CronService, impl: ExecuteActionPatch): void {
  (service as unknown as { executeAction: ExecuteActionPatch }).executeAction = impl;
}

function trustError(kind: ProjectSourceTrustFailureKind, sourcePath: string): Error {
  return Object.assign(new ProjectSourceTrustError(kind, sourcePath), { cronSessionId: `cron-session-${kind}` });
}

function agentJob(maxRetries = 0) {
  return {
    name: '每天早上整理笔记',
    scheduleType: 'every' as const,
    schedule: { type: 'every' as const, interval: 12, unit: 'hours' as const },
    action: { type: 'agent' as const, agentType: 'default', prompt: '把项目文件夹里的笔记整理成一份简短晨报' },
    enabled: true,
    ...(maxRetries ? { maxRetries, retryDelay: 1 } : {}),
  };
}

function storedErrorFor(executionId: string): unknown {
  return dbState.executionRows.filter((row) => row.id === executionId).at(-1)?.error;
}

function expectNoPathOrEnglish(text: string): void {
  expect(text).not.toContain('/Users/');
  expect(text).not.toContain('Project Source');
}

describe('cron 项目文件夹信任失败落库为稳定标记', () => {
  it.each([
    ['identity_changed', 'PROJECT_SOURCE_TRUST:identity_changed:notes-proj'],
    ['source_missing', 'PROJECT_SOURCE_TRUST:source_missing:notes-proj'],
    ['not_trusted', 'PROJECT_SOURCE_TRUST:not_trusted:notes-proj'],
  ] as const)('触发路径（executeJob catch）：%s 落 %s，通知无路径无英文句', async (kind, marker) => {
    const service = new CronService();
    const job = await service.createJob(agentJob());
    patchExecuteAction(service, async () => { throw trustError(kind, '/Users/someone/work/notes-proj'); });

    const execution = (await service.triggerJob(job.id))!;

    expect(execution.status).toBe('failed');
    expect(execution.error).toBe(marker);
    expect(storedErrorFor(execution.id)).toBe(marker);
    const payload = JSON.stringify(notifyState.notifyTaskComplete.mock.calls);
    expect(payload).toContain('定时任务失败：项目文件夹需要重新确认。');
    expectNoPathOrEnglish(payload);
    expect(payload).not.toContain('notes-proj');
    await service.shutdown();
  });

  it('重试路径（retryExecution catch）：第二次撞上信任失败也只落标记', async () => {
    vi.useFakeTimers();
    const service = new CronService();
    const job = await service.createJob(agentJob(1));
    let calls = 0;
    patchExecuteAction(service, async () => {
      calls += 1;
      if (calls === 1) throw new Error('provider 502: upstream broken');
      throw trustError('identity_changed', '/Users/someone/work/notes-proj/');
    });

    const settled = service.triggerJob(job.id);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);
    const execution = (await settled)!;

    expect(calls).toBe(2);
    expect(execution.retryAttempt).toBe(1);
    expect(execution.error).toBe('PROJECT_SOURCE_TRUST:identity_changed:notes-proj');
    expect(storedErrorFor(execution.id)).toBe('PROJECT_SOURCE_TRUST:identity_changed:notes-proj');
    expectNoPathOrEnglish(JSON.stringify(notifyState.notifyTaskComplete.mock.calls));
    await service.shutdown();
  });

  it('cause 链里包着的信任失败同样只落标记；路径末段不安全时不带文件夹名', async () => {
    const service = new CronService();
    const job = await service.createJob(agentJob());
    const wrapped = new Error('agent run failed', { cause: trustError('source_missing', '/') });
    patchExecuteAction(service, async () => { throw wrapped; });

    const execution = (await service.triggerJob(job.id))!;

    expect(execution.error).toBe('PROJECT_SOURCE_TRUST:source_missing');
    expect(storedErrorFor(execution.id)).toBe('PROJECT_SOURCE_TRUST:source_missing');
    await service.shutdown();
  });
});
