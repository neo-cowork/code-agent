import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { CanUseToolFn, ToolContext } from '../../../../src/host/protocol/tools';
import {
  getSessionCommandCenter,
  resetSessionCommandCenterForTest,
} from '../../../../src/host/services/commandCenter/sessionCommandCenter';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import { resetBackgroundTaskLedgerForTest } from '../../../../src/host/task/backgroundTaskLedger';
import { executeDelegateTask } from '../../../../src/host/tools/modules/commandCenter/sessionCommandCenter';
import { createWorkspaceScope } from '../../../../src/host/runtime/workspaceScope';

const persistMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../../../src/host/services/infra/sessionManager', () => ({ getSessionManager: () => ({ addMessageToSession: persistMessage }) }));

const holder = vi.hoisted(() => ({ manager: undefined as unknown }));
vi.mock('../../../../src/host/task/TaskManager', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTaskManager: () => holder.manager,
}));

const leftovers = vi.hoisted(() => ({ paths: undefined as string[] | undefined }));
vi.mock('../../../../src/host/session/approvedRmSettlementTargets', () => ({
  hasApprovedRmSettlementTargets: () => true,
  takeApprovedRmLeftovers: () => leftovers.paths,
}));

vi.mock('../../../../src/host/services/infra/notificationService', () => ({ notificationService: { notifyTaskComplete: vi.fn() } }));

const terminalParked = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../../../src/host/app/applicationRunRegistry', () => ({
  getConfiguredApplicationRunRegistry: () => ({ terminalRecoveredWaitingRun: terminalParked }),
}));

class FakeTaskManager extends EventEmitter {
  startBackgroundTask = vi.fn().mockResolvedValue(undefined);
  interruptBackgroundTask = vi.fn().mockResolvedValue(true);
  cancelBackgroundTask = vi.fn().mockResolvedValue(true);
  observeAgentEvents(): () => void { return () => {}; }
}

const SCOPE = createWorkspaceScope('p', [{ sourceId: 's', path: '/tmp/cc-delete', role: 'primary', access: 'read_write' }]);
const ctx = (sessionId: string): ToolContext => ({
  sessionId, workingDir: SCOPE.primaryRoot, workspace: SCOPE.primaryRoot, workspaceScope: SCOPE,
  abortSignal: new AbortController().signal,
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, emit: vi.fn(),
} as unknown as ToolContext);
const allow: CanUseToolFn = vi.fn().mockResolvedValue({ allow: true });

async function settleDelegated(): Promise<string> {
  const session = 'session-delete-incomplete';
  await executeDelegateTask({
    title: '清理旧缓存', short_name: '清理', lane_key: 'l', submission_key: 's', prompt: '把旧报表缓存删掉',
  }, ctx(session), allow);
  const task = getSessionCommandCenter().list(session)[0];
  await (getSessionCommandCenter() as unknown as {
    settle(t: unknown, s: string, d?: string): Promise<void>;
  }).settle(task, 'completed', '已删除');
  return task.id;
}

describe('delegated delete that left the file is not parked as a crash', () => {
  beforeEach(() => {
    resetSessionCommandCenterForTest();
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
    holder.manager = new FakeTaskManager();
    terminalParked.mockClear();
  });
  afterEach(() => resetSessionCommandCenterForTest());

  it('closes the parked durable run of a DELETE_INCOMPLETE task', async () => {
    leftovers.paths = ['/tmp/old-report-cache.tmp'];
    const id = await settleDelegated();
    expect(terminalParked).toHaveBeenCalledWith({ runId: id }, expect.any(Number), { abandonParked: true });
  });

  it('leaves the durable run alone when the file really went away', async () => {
    leftovers.paths = undefined;
    await settleDelegated();
    expect(terminalParked).not.toHaveBeenCalled();
  });
});
