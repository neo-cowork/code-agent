import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectorExecute: vi.fn(),
  getSchemas: vi.fn(),
  has: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('../../../src/host/tools/protocolRegistry', () => ({
  getProtocolRegistry: () => ({
    getSchemas: mocks.getSchemas,
    has: mocks.has,
    resolve: mocks.resolve,
  }),
  isProtocolToolName: vi.fn(() => false),
  resetProtocolRegistry: vi.fn(),
}));

vi.mock('../../../src/host/tools/protocolToolRegistration', () => ({
  getProtocolToolSchemas: mocks.getSchemas,
  hasProtocolTool: mocks.has,
  resolveProtocolTool: mocks.resolve,
  registerProtocolTool: vi.fn(),
  unregisterProtocolTool: vi.fn(),
  setProtocolToolRegistryPort: vi.fn(),
}));

vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({
    getAllToolMeta: () => ({}),
  }),
}));

vi.mock('../../../src/host/mcp', () => ({
  getMCPClient: () => ({
    getToolDefinitions: () => [],
    parseMCPToolName: () => null,
  }),
}));

vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
    invalidateForPath: vi.fn(),
    invalidateForWorkspace: vi.fn(),
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));


vi.mock('../../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({ get: () => ({ execute: mocks.connectorExecute }) }),
}));

import { remindersCreateModule } from '../../../src/host/tools/modules/connectors/remindersCreate';
import type { PermissionRequestData } from '../../../src/host/tools/types';
const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');
const { resetToolResolver } = await import('../../../src/host/tools/dispatch/toolResolver');

let session = 0;
function executor(requestPermission: ConstructorParameters<typeof ToolExecutor>[0]['requestPermission']) {
  const instance = new ToolExecutor({ workingDirectory: process.cwd(), requestPermission, forcePermissionHandler: true });
  instance.setAuditEnabled(false);
  return instance;
}

describe('reminder wall-clock normalization before executor approval', () => {
  beforeEach(() => {
    resetToolResolver();
    vi.stubEnv('TZ', 'Asia/Shanghai');
    mocks.getSchemas.mockReturnValue([remindersCreateModule.schema]);
    mocks.has.mockImplementation((name: string) => name === 'reminders_create');
    mocks.resolve.mockImplementation(() => remindersCreateModule.createHandler());
    mocks.connectorExecute.mockReset();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('shows the normalized instant on the real card before dispatching public execute', async () => {
    const ms = Date.parse('2026-11-09T01:00:00Z');
    const requestPermission = vi.fn(async (request: PermissionRequestData) => {
      expect(mocks.connectorExecute).not.toHaveBeenCalled();
      expect(request.details).toMatchObject({ remind_at_ms: ms, preview: { summary: '创建提醒', diff: expect.stringContaining('2026/11/9 09:00:00') } });
      expect(request.details).not.toHaveProperty('remind_at_local');
      return true;
    });
    mocks.connectorExecute.mockResolvedValue({ data: { id: 'actual', list: '提醒事项', title: 'Report', completed: false, remindAtMs: ms } });
    const args = { title: 'Report', remind_at_local: '2026-11-09 09:00' };
    const result = await executor(requestPermission).execute('reminders_create', args, { sessionId: `local-${++session}` });
    expect(result).toMatchObject({ success: true, output: expect.stringContaining('提醒时间：2026-11-09 09:00 (UTC+8)（周一，Asia/Shanghai）') });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(mocks.connectorExecute).toHaveBeenCalledWith('create_reminder', { title: 'Report', remind_at_ms: ms });
    expect(args).not.toHaveProperty('remind_at_ms');
  });

  it('preserves an approval-card time edit instead of restoring stale local input', async () => {
    const editedMs = Date.parse('2026-11-09T02:15:00Z');
    mocks.connectorExecute.mockResolvedValue({ data: { id: 'edited', list: 'Work', title: 'Report', completed: false, remindAtMs: editedMs } });
    const requestPermission = vi.fn(async (request: PermissionRequestData) => {
      expect(request.details).toHaveProperty('remind_at_ms', Date.parse('2026-11-09T01:00:00Z'));
      return { approved: true, updatedArgs: { remind_at_ms: editedMs } };
    });
    const result = await executor(requestPermission).execute('reminders_create', { list: 'Work', title: 'Report', remind_at_local: '2026-11-09 09:00' }, { sessionId: `edit-${++session}` });
    expect(result).toMatchObject({ success: true, output: expect.stringContaining('2026-11-09 10:15') });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(mocks.connectorExecute).toHaveBeenCalledWith('create_reminder', { list: 'Work', title: 'Report', remind_at_ms: editedMs });
  });

  it.each(['bad', '2026-02-30 09:00'])('returns INVALID_ARGS for %s before the approval card', async (local) => {
    const requestPermission = vi.fn(async () => true);
    expect(await executor(requestPermission).execute('reminders_create', { title: 'Bad', remind_at_local: local }, { sessionId: `invalid-${++session}` })).toMatchObject({ success: false, metadata: { code: 'INVALID_ARGS' } });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(mocks.connectorExecute).not.toHaveBeenCalled();
  });

  it('keeps epoch-only input unchanged before approval and dispatch', async () => {
    const ms = Date.parse('2026-11-09T01:00:00Z');
    const args = { title: 'Epoch', remind_at_ms: ms };
    const requestPermission = vi.fn(async (request: PermissionRequestData) => {
      expect(request.details).toHaveProperty('remind_at_ms', ms);
      return true;
    });
    mocks.connectorExecute.mockResolvedValue({ data: { id: 'epoch', list: 'Work', title: 'Epoch', completed: false, remindAtMs: ms } });
    expect(await executor(requestPermission).execute('reminders_create', args, { sessionId: `epoch-${++session}` })).toMatchObject({ success: true, output: expect.stringContaining('2026-11-09 09:00') });
    expect(mocks.connectorExecute).toHaveBeenCalledWith('create_reminder', args);
  });

  it('still denies a normalized create when approval is refused', async () => {
    const requestPermission = vi.fn(async () => false);
    expect(await executor(requestPermission).execute('reminders_create', { title: 'Denied', remind_at_local: '2026-11-09 09:00' }, { sessionId: `deny-${++session}` })).toMatchObject({ success: false });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(mocks.connectorExecute).not.toHaveBeenCalled();
  });
});
