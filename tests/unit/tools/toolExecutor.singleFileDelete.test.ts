import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    isCacheable: () => false,
    get: () => null,
    set: vi.fn(),
  }),
}));

vi.mock('../../../src/host/tools/middleware/fileCheckpointMiddleware', () => ({
  createFileCheckpointIfNeeded: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/host/agent/confirmationGate', () => ({
  getConfirmationGate: () => ({
    buildPreview: () => null,
    assessRiskLevel: () => 'low',
    shouldConfirm: () => false,
  }),
}));

vi.mock('../../../src/host/security/writeIsolation', () => ({
  getWriteIsolationManager: () => ({
    acquire: vi.fn(async () => () => {}),
  }),
  getWriteIsolationScope: () => null,
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

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');
import { isDangerousCommand } from '../../../src/host/tools/toolExecutorHelpers';

beforeEach(() => {
  resolverState.getDefinition.mockReset();
  resolverState.getDefinition.mockReturnValue({
    name: 'Bash',
    description: 'shell test tool',
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresPermission: true,
    permissionLevel: 'execute',
  });
  resolverState.execute.mockReset();
});

describe('ToolExecutor rm approval requests', () => {
  it.each([
    ['', 'old-notes.txt', 'command', 'medium', 'single_file_delete', 1],
    ['-v ', 'old-notes.txt', 'command', 'medium', 'single_file_delete', 1],
    ['-r ', 'old-drafts', 'dangerous_command', 'high', 'recursive_delete_targeted', 2],
    ['-rf ', 'old-drafts', 'dangerous_command', 'high', 'recursive_delete_targeted', 2],
    ['-f ', 'old-notes.txt', 'dangerous_command', 'high', 'recursive_delete_targeted', 1],
  ])('requests permission for rm %s%s as %s (%s, %s)', async (options, name, type, risk, flag, count) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-single-file-delete-'));
    const drafts = path.join(workspace, 'old-drafts');
    const target = path.join(workspace, name);
    const requestPermission = vi.fn(async (_request: unknown) => false);
    try {
      fs.mkdirSync(drafts);
      fs.writeFileSync(path.join(drafts, 'first.txt'), 'first');
      fs.writeFileSync(path.join(drafts, 'second.txt'), 'second');
      fs.writeFileSync(path.join(workspace, 'old-notes.txt'), 'old note');
      const executor = new ToolExecutor({ requestPermission, workingDirectory: workspace, forcePermissionHandler: true });
      executor.setAuditEnabled(false);

      await executor.execute('Bash', { command: `rm ${options}"${target}"` }, { sessionId: 's1' });

      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(requestPermission.mock.calls[0][0]).toMatchObject({
        type,
        details: {
          commandRiskLevel: risk,
          commandSecurityFlags: risk === 'medium' ? [flag] : expect.arrayContaining([flag]),
          affectedPath: target,
          affectedFileCount: count,
        },
      });
      expect(resolverState.execute).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps the warden’s default detection of irreversible commands', () => {
    expect(isDangerousCommand('rm /Users/u/a.txt')).toBe(true);
  });
});
