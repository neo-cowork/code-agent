// N-FIX-BGTASK-RESULT-HANDBACK-1500-CAP：后台任务结果整段交给前台，超预算给存档指针。
import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TaskManager, TaskManagerEvent } from '../../../src/host/task/TaskManager';

const hoisted = vi.hoisted(() => ({
  warn: vi.fn(),
  failSpill: { on: false },
}));

vi.mock('../../../src/host/config/configPaths', async () => {
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  return { getUserConfigDir: () => pathMod.join(osMod.tmpdir(), `neo-handback-test-${process.pid}`) };
});
vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/infra/logger')>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const real = actual.createLogger(name);
      return name === 'TaskResultHandback' ? { ...real, warn: hoisted.warn } : real;
    },
  };
});
vi.mock('../../../src/host/utils/toolResultSpill', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/utils/toolResultSpill')>();
  return {
    ...actual,
    spillToolResultArchive: (options: Parameters<typeof actual.spillToolResultArchive>[0]) =>
      hoisted.failSpill.on ? null : actual.spillToolResultArchive(options),
  };
});

import { SessionCommandCenter } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import { resetBackgroundTaskLedgerForTest } from '../../../src/host/task/backgroundTaskLedger';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import { getSessionManager } from '../../../src/host/services/infra/sessionManager';
import { findToolResultArchiveRef, readToolResultArchive } from '../../../src/host/utils/toolResultSpill';

class FakeTaskManager extends EventEmitter {
  startBackgroundTask = vi.fn().mockResolvedValue(undefined);
  interruptBackgroundTask = vi.fn().mockResolvedValue(true);
  cancelBackgroundTask = vi.fn().mockResolvedValue(true);
  observeAgentEvents() { return () => undefined; }
  emitTask(event: TaskManagerEvent): void { this.emit(event.type, event); }
}

const SCOPE = createWorkspaceScope('project-handback', [{
  sourceId: 'source-handback', path: '/tmp/handback-project', role: 'primary', access: 'read_write',
}]);

async function settleWith(conclusion: string) {
  const manager = new FakeTaskManager();
  const add = vi.spyOn(getSessionManager(), 'addMessageToSession').mockResolvedValue(undefined);
  const center = new SessionCommandCenter(manager as unknown as TaskManager, { wakeForegroundBrain: vi.fn() });
  const spawned = await center.spawn({
    sessionId: 'session-handback', title: '读页面', shortName: '读页面', laneKey: 'lane-1',
    submissionKey: 'sub-1', prompt: '读取页面', workspaceScope: SCOPE,
  });
  if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');
  manager.emitTask({ type: 'task_completed', sessionId: 'session-handback', data: { taskId: spawned.task.id, conclusion } });
  await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
  const message = add.mock.calls[0][1];
  const settled = center.list('session-handback').find((t) => t.id === spawned.task.id);
  return { message, settled, done: () => { add.mockRestore(); center.dispose(); } };
}

describe('background task result handback', () => {
  beforeEach(() => {
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
    hoisted.warn.mockClear();
    hoisted.failSpill.on = false;
  });
  afterAll(() => fs.rmSync(path.join(os.tmpdir(), `neo-handback-test-${process.pid}`), { recursive: true, force: true }));

  it('(a) delivers a 2205-char three-bullet result whole with newlines intact', async () => {
    const bullets = [1, 2, 3].map((n) => `- 要点${n}：${'内容'.repeat(350)}[P${n}-END]`);
    const conclusion = bullets.join('\n');
    expect(Array.from(conclusion).length).toBeGreaterThan(2000);
    const { message, settled, done } = await settleWith(conclusion);
    try {
      expect(message.content).toBe(`[任务结果] 读页面｜已完成｜${conclusion}`);
      expect(message.content).not.toContain('truncated');
      expect(settled?.resultText).toBe(conclusion);
      expect(settled?.resultText?.split('\n')).toHaveLength(3);
      for (const n of [1, 2, 3]) expect(message.content).toContain(`[P${n}-END]`);
      // 卡片摘要维持历史口径：折叠空白、1500 封顶
      const flat = Array.from(conclusion.replace(/\s+/g, ' '));
      expect(message.metadata?.backgroundTaskResult?.summary)
        .toBe(`${flat.slice(0, 1500).join('')}…(truncated, ${flat.length} chars total)`);
    } finally { done(); }
  });

  it('(b) archives a 12000-char result: head + pointer in message, exact full text in archive, clean card summary', async () => {
    const conclusion = Array.from({ length: 12 }, (_, i) => `第${i + 1}节 ${'详'.repeat(990)}`).join('\n');
    expect(conclusion.length).toBeGreaterThan(11000);
    const { message, settled, done } = await settleWith(conclusion);
    try {
      const content = message.content;
      expect(content).toContain('archive=');
      expect(content).toContain('read_tool_result_archive');
      expect(content).toContain('第1节');
      expect(content).not.toContain('第12节');
      expect(content).not.toContain('truncated');
      expect(settled?.resultText).toContain('archive=');

      const artifactId = /archive=([^;\s]+)/.exec(content)?.[1];
      expect(artifactId).toBeTruthy();
      const ref = findToolResultArchiveRef(artifactId!, 'session-handback');
      expect(ref).not.toBeNull();
      expect(readToolResultArchive(ref!)?.content).toBe(conclusion);

      const summary = message.metadata?.backgroundTaskResult?.summary ?? '';
      expect(summary).not.toContain('archive=');
      expect(summary).not.toContain('read_tool_result_archive');
      expect(Array.from(summary).length).toBeLessThanOrEqual(1500 + 40);
    } finally { done(); }
  });

  it('(c) warns with a distinguishable reason and keeps the truncation marker when archiving fails', async () => {
    hoisted.failSpill.on = true;
    const conclusion = 'y'.repeat(9000);
    const { message, done } = await settleWith(conclusion);
    try {
      expect(message.content).toContain('…(truncated, 9000 chars total)');
      expect(message.content).not.toContain('archive=');
      expect(hoisted.warn).toHaveBeenCalledWith(
        expect.stringContaining('could not be archived'),
        expect.objectContaining({ reason: 'task_result_spill_failed', chars: 9000 }),
      );
    } finally { done(); }
  });
});
