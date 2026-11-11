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
import { markShortTierSession } from '../../../../../src/host/tools/shell/foregroundTier';
import { BASH } from '../../../../../src/shared/constants';

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

describe('Bash background runtime selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.background.mockReturnValue({ success: true, taskId: 'runtime-task' });
    mocks.pty.mockReturnValue({ success: true, sessionId: 'runtime-pty' });
    mocks.foreground.mockResolvedValue({ stdout: '', stderr: '' });
  });

  it.each([
    { label: 'omitted timeout', timeout: undefined, expected: BASH.BACKGROUND_MAX_RUNTIME },
    { label: 'explicit timeout', timeout: 30000, expected: 30000 },
  ])('uses $label for an explicit background launch', async ({ timeout, expected }) => {
    const result = await execute({ command: 'date', run_in_background: true, ...(timeout === undefined ? {} : { timeout }) });
    expect(result.ok).toBe(true);
    expect(mocks.background).toHaveBeenCalledExactlyOnceWith(
      'date', expect.any(String), expected, expect.objectContaining({ sessionId: 'background-runtime' }),
    );
    expect(mocks.foreground).not.toHaveBeenCalled();
  });

  it.each([0, -1, '30000', 'invalid', null, Number.NaN, false].flatMap((timeout) => [
    { timeout, pty: false }, { timeout, pty: true },
  ]))('uses the background limit for invalid timeout $timeout with PTY=$pty', async ({ timeout, pty }) => {
    expect((await execute({ command: 'date', run_in_background: true, pty, timeout })).ok).toBe(true);
    if (pty) {
      expect(mocks.pty).toHaveBeenCalledWith(expect.objectContaining({ maxRuntime: BASH.BACKGROUND_MAX_RUNTIME }));
      expect(mocks.background).not.toHaveBeenCalled();
    } else {
      expect(mocks.background).toHaveBeenCalledExactlyOnceWith(
        'date', expect.any(String), BASH.BACKGROUND_MAX_RUNTIME, expect.any(Object),
      );
      expect(mocks.pty).not.toHaveBeenCalled();
    }
  });

  it('uses the background limit after an implicit ampersand rewrite', async () => {
    expect((await execute({ command: 'date &' })).ok).toBe(true);
    expect(mocks.background.mock.calls[0]?.slice(0, 3)).toEqual(['date', expect.any(String), BASH.BACKGROUND_MAX_RUNTIME]);
  });

  it('keeps the foreground default at 120000', async () => {
    expect((await execute({ command: 'date' })).ok).toBe(true);
    expect(mocks.foreground).toHaveBeenCalledWith(expect.objectContaining({ timeout: BASH.DEFAULT_TIMEOUT }));
    expect(BASH.DEFAULT_TIMEOUT).toBe(120000);
    expect(mocks.background).not.toHaveBeenCalled();
  });

  it.each([
    { wait_for_completion: undefined, timeout: undefined, expected: BASH.BACKGROUND_MAX_RUNTIME },
    { wait_for_completion: false, timeout: 30000, expected: 30000 },
    { wait_for_completion: true, timeout: undefined, expected: BASH.DEFAULT_TIMEOUT },
  ])('selects PTY runtime for $wait_for_completion / $timeout', async ({ wait_for_completion, timeout, expected }) => {
    expect((await execute({ command: 'date', pty: true, wait_for_completion, timeout })).ok).toBe(true);
    expect(mocks.pty).toHaveBeenCalledWith(expect.objectContaining({ maxRuntime: expected }));
  });

  it.each([undefined, 30000])('preserves short-tier background and PTY clamping for %s', async (timeout) => {
    const sessionId = 'background-runtime-short';
    markShortTierSession(sessionId);
    const expected = timeout === undefined ? BASH.SHORT_TIER_TIMEOUT : Math.min(timeout, BASH.SHORT_TIER_TIMEOUT);
    expect((await execute({ command: 'date', run_in_background: true, timeout }, sessionId)).ok).toBe(true);
    expect(mocks.background.mock.calls[0]?.[2]).toBe(expected);
    expect((await execute({ command: 'date', pty: true, timeout }, sessionId)).ok).toBe(true);
    expect(mocks.pty).toHaveBeenCalledWith(expect.objectContaining({ maxRuntime: expected }));
  });
});
