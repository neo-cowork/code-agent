import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../../../src/host/protocol/tools';

const mocks = vi.hoisted(() => ({ background: vi.fn(), pty: vi.fn(), foreground: vi.fn() }));
vi.mock('../../../../../src/host/tools/shell/backgroundTasks', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../../src/host/tools/shell/backgroundTasks')>(),
  startBackgroundTask: mocks.background,
}));
vi.mock('../../../../../src/host/tools/shell/ptyExecutor', () => ({
  createPtySession: mocks.pty,
  getPtySessionOutput: vi.fn(async () => ({ status: 'completed', output: '', exitCode: 0 })),
}));
vi.mock('../../../../../src/host/tools/modules/shell/foregroundCommand', () => ({
  runForegroundCommand: mocks.foreground,
}));
vi.mock('../../../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));
vi.mock('../../../../../src/host/sandbox', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../../src/host/sandbox')>(),
  wrapCommandForSandbox: (command: string) => ({ command, cleanup: () => {} }),
}));

import { bashModule } from '../../../../../src/host/tools/modules/shell/bash';

function context(sessionId = 'background-runtime'): ToolContext {
  return {
    sessionId,
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emit: () => {},
    policyEnforcer: null,
  };
}

async function execute(args: Record<string, unknown>, sessionId?: string) {
  const handler = await bashModule.createHandler();
  return handler.execute(args, context(sessionId), async () => ({ allow: true }));
}

describe('Bash padded command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.foreground.mockResolvedValue({ stdout: '', stderr: '' });
  });

  it('executes the trimmed command', async () => {
    expect((await execute({ command: '  date\n' })).ok).toBe(true);
    expect(mocks.foreground).toHaveBeenCalled();
    const sent = JSON.stringify(mocks.foreground.mock.calls[0]);
    expect(sent).toContain('date');
    expect(sent).not.toContain('  date');
    expect(sent).not.toContain('date\\n');
  });
});
