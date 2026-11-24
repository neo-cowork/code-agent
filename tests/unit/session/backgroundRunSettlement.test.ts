// ============================================================================
// BackgroundRunSettlement 决策表（N-RUNINPUT-TOBACKGROUND-OPTION 2026-10-11 rework）
// ============================================================================
// web 直连轮（agent.ts）的终态收线决策：只认 completed 时，max-step 撞顶（error 事件
// 带 MAX_ITERATIONS code）/失败/取消轮会把后台面板 spinner 挂在 running 永不收线
// （无槽验收实测）。决策钉成纯函数，web 路与桌面 TaskManager 共用。

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_TASK_CANCELLED, BACKGROUND_TASK_DELETE_INCOMPLETE, RUN_ERROR_CODE_MAX_ITERATIONS } from '../../../src/shared/constants';
import {
  resolveBackgroundRunSettlement,
  settleBackgroundRun,
} from '../../../src/host/session/backgroundRunSettlement';

describe('resolveBackgroundRunSettlement（终态 → 收线动作）', () => {
  it('completed → markCompleted（无消息）', () => {
    expect(resolveBackgroundRunSettlement({ status: 'completed' }))
      .toEqual({ action: 'markCompleted' });
  });

  it('interrupted（取消/中断）→ markCompleted + USER_CANCELLED 标记（用户主动停，不算失败）', () => {
    expect(resolveBackgroundRunSettlement({ status: 'interrupted' }))
      .toEqual({ action: 'markCompleted', message: BACKGROUND_TASK_CANCELLED });
  });

  it('error + max-step 撞顶 code → markFailed 传稳定 code（renderer 翻译，不弹英文内部串）', () => {
    expect(resolveBackgroundRunSettlement({
      status: 'error',
      errorMessage: 'Max iterations reached',
      errorCode: RUN_ERROR_CODE_MAX_ITERATIONS,
    })).toEqual({ action: 'markFailed', message: RUN_ERROR_CODE_MAX_ITERATIONS });
  });

  it('error + 普通消息 → markFailed 传原始消息', () => {
    expect(resolveBackgroundRunSettlement({
      status: 'error',
      errorMessage: 'Provider auth failure',
    })).toEqual({ action: 'markFailed', message: 'Provider auth failure' });
  });

  it('error + 无消息 → markFailed 无消息（面板回落默认失败行）', () => {
    expect(resolveBackgroundRunSettlement({ status: 'error' }))
      .toEqual({ action: 'markFailed', message: undefined });
  });
});

describe('settleBackgroundRun（动作分发）', () => {
  it('markFailed 分支 → markFailed(sessionId, message)', () => {
    const manager = { markCompleted: vi.fn(), markFailed: vi.fn() };
    void settleBackgroundRun(manager, 's1', { action: 'markFailed', message: 'boom' });
    expect(manager.markFailed).toHaveBeenCalledWith('s1', 'boom');
    expect(manager.markCompleted).not.toHaveBeenCalled();
  });

  it('markCompleted 分支 → await markCompleted(sessionId, message)', async () => {
    const manager = { markCompleted: vi.fn().mockResolvedValue(undefined), markFailed: vi.fn() };
    await settleBackgroundRun(manager, 's1', { action: 'markCompleted', message: BACKGROUND_TASK_CANCELLED });
    expect(manager.markCompleted).toHaveBeenCalledWith('s1', BACKGROUND_TASK_CANCELLED);
    expect(manager.markFailed).not.toHaveBeenCalled();
  });
});


const manager = vi.hoisted(() => ({
  isInBackground: vi.fn(() => true),
  isTaskRunning: vi.fn(() => true),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
}));

vi.mock('../../../src/host/session/backgroundTaskManager', () => ({
  getBackgroundTaskManager: () => manager,
}));
vi.mock('../../../src/host/services', () => ({
  getSessionManager: vi.fn(),
  notificationService: { notifyTaskComplete: vi.fn() },
}));

import { closeBackgroundRunAtTerminal, settleBackgroundOnTaskComplete } from '../../../src/host/task/backgroundTaskTerminal';
import { approvedSingleFileRmGrant } from '../../../src/host/tools/shell/sandboxEscalation';
import { resolveCanonicalRunPath } from '../../../src/host/runtime/runContext';

describe('approved delete through the desktop terminal entry', () => {
  let cwd: string | undefined;
  const sessionId = 'delete-session';
  const runId = 'delete-run';

  function approve({ exists = true, wrapper = '' } = {}): string {
    cwd = resolveCanonicalRunPath(mkdtempSync(join(tmpdir(), 'neo-delete-settlement-')));
    const file = join(cwd, 'export.csv');
    if (exists) writeFileSync(file, 'export');
    const grant = approvedSingleFileRmGrant(`rm -- '${file}'${wrapper}`, {
      sandboxDecision: { sandboxed: true },
      foreground: true,
      pty: false,
      background: false,
      unattended: false,
      writeFence: false,
      evalRealRoot: false,
      permissionMode: 'default',
      abortSignal: new AbortController().signal,
      newFileGrantSupported: true,
      workingDirectory: cwd,
      policyEnforcer: null,
      sessionId,
      runId,
    });
    expect(grant).toBe(exists ? file : undefined);
    return file;
  }

  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    cwd = undefined;
    vi.clearAllMocks();
  });

  it.each([
    { shape: 'wrapper exit 0 and rm_exit=1', wrapper: '; echo rm_exit=$?', output: 'rm_exit=1', exitCode: 0 },
    { shape: 'Operation not permitted', wrapper: '', output: 'rm: export.csv: Operation not permitted', exitCode: 1 },
    { shape: 'plain failure', wrapper: '', output: 'rm: export.csv: failed', exitCode: 1 },
  ])('marks an existing file DELETE_INCOMPLETE after $shape', async ({ wrapper, output, exitCode }) => {
    const file = approve({ wrapper });
    // The shell result is followed by the agent's ordinary successful terminal events.
    // The file left on disk is the fact both settlement paths must use.
    await settleBackgroundOnTaskComplete(sessionId, sessionId, {
      summary: `${output}
Shell exit: ${exitCode}`,
    }, undefined, runId);
    expect(manager.markCompleted).not.toHaveBeenCalled();
    await closeBackgroundRunAtTerminal(sessionId, 'agent_complete', new Map(), runId);
    expect(manager.markFailed).toHaveBeenCalledExactlyOnceWith(sessionId, BACKGROUND_TASK_DELETE_INCOMPLETE, undefined, [file]);
    expect(manager.markCompleted).not.toHaveBeenCalled();
  });

  it('keeps completion when the approved delete removed the file', async () => {
    unlinkSync(approve());
    await closeBackgroundRunAtTerminal(sessionId, 'agent_complete', new Map(), runId);
    expect(manager.markCompleted).toHaveBeenCalledExactlyOnceWith(sessionId, undefined);
    expect(manager.markFailed).not.toHaveBeenCalled();
  });

  it('keeps completion when the file was missing before approval', async () => {
    writeFileSync(approve({ exists: false }), 'created later');
    await closeBackgroundRunAtTerminal(sessionId, 'agent_complete', new Map(), runId);
    expect(manager.markCompleted).toHaveBeenCalledExactlyOnceWith(sessionId, undefined);
    expect(manager.markFailed).not.toHaveBeenCalled();
  });

  it('keeps completion with no recorded targets', async () => {
    await closeBackgroundRunAtTerminal(sessionId, 'agent_complete', new Map(), runId);
    expect(manager.markCompleted).toHaveBeenCalledExactlyOnceWith(sessionId, undefined);
    expect(manager.markFailed).not.toHaveBeenCalled();
  });

  it('isolates another run in the same session and consumes the original targets once', async () => {
    const file = approve();
    await closeBackgroundRunAtTerminal(sessionId, 'agent_complete', new Map(), 'other-run');
    expect(manager.markFailed).not.toHaveBeenCalled();
    await closeBackgroundRunAtTerminal(sessionId, 'agent_complete', new Map(), runId);
    expect(manager.markFailed).toHaveBeenCalledExactlyOnceWith(sessionId, BACKGROUND_TASK_DELETE_INCOMPLETE, undefined, [file]);
    vi.clearAllMocks();
    await closeBackgroundRunAtTerminal(sessionId, 'agent_complete', new Map(), runId);
    expect(manager.markCompleted).toHaveBeenCalledExactlyOnceWith(sessionId, undefined);
  });

  it('preserves error and cancellation despite approved delete leftovers', () => {
    const leftoverPaths = ['export.csv'];
    expect(resolveBackgroundRunSettlement({ status: 'error', errorMessage: 'provider error', leftoverPaths }))
      .toEqual({ action: 'markFailed', message: 'provider error' });
    expect(resolveBackgroundRunSettlement({ status: 'interrupted', leftoverPaths }))
      .toEqual({ action: 'markCompleted', message: BACKGROUND_TASK_CANCELLED });
  });
});
