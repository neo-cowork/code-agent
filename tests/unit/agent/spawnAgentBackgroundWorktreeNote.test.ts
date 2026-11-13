import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const worktreeMocks = vi.hoisted(() => ({
  cleanupAgentWorktree: vi.fn(),
  discardAgentWorktree: vi.fn(),
}));
vi.mock('../../../src/host/agent/agentWorktree', () => worktreeMocks);
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  delegateSpawnAgentWorktreeCleanup,
  withBackgroundWorktreeNote,
} from '../../../src/host/agent/multiagentTools/spawnAgentForegroundBackground';
import type { SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';

const ok = { success: true, output: 'report body', iterations: 1, toolsUsed: [] } as unknown as SubagentResult;

function runDelegate(status: 'completed' | 'cancelled') {
  let callback: (agent: { id: string; status: string }) => Promise<void> | void = () => {};
  const notes: string[] = [];
  let finalized = false;
  delegateSpawnAgentWorktreeCleanup({
    guard: { onComplete: (cb) => { callback = cb as typeof callback; } },
    agentId: 'agent-1',
    repoPath: '/Users/tester/repo',
    worktreeInfo: { worktreePath: '/var/folders/x/wt', baseCommit: 'abc' },
    isFinalized: () => finalized,
    markFinalized: () => { finalized = true; },
    onSettled: (note) => notes.push(note),
  });
  return { fire: () => callback({ id: 'agent-1', status }), notes };
}

afterEach(() => {
  vi.useRealTimers();
  worktreeMocks.cleanupAgentWorktree.mockReset();
  worktreeMocks.discardAgentWorktree.mockReset();
});

describe('background spawn_agent worktree note', () => {
  it('reports the branch to merge, never the absolute path', async () => {
    worktreeMocks.cleanupAgentWorktree.mockResolvedValue({ hasChanges: true, branchName: 'agent/agent-1', worktreePath: '/var/folders/x/wt' });
    const { fire, notes } = runDelegate('completed');
    await fire();
    expect(notes).toEqual(['\n- Worktree: preserved (branch: agent/agent-1) — review and merge changes']);
    expect(notes[0]).not.toContain('/var/folders');
  });

  it('reports auto-clean and cancellation outcomes', async () => {
    worktreeMocks.cleanupAgentWorktree.mockResolvedValue({ hasChanges: false });
    const clean = runDelegate('completed');
    await clean.fire();
    expect(clean.notes).toEqual(['\n- Worktree: auto-cleaned (no changes)']);
    const cancelled = runDelegate('cancelled');
    await cancelled.fire();
    expect(cancelled.notes).toEqual(['\n- Worktree: discarded after cancellation']);
  });

  it('appends the note to the adopted child result (success and failure)', async () => {
    const note = '\n- Worktree: preserved (branch: agent/agent-1) — review and merge changes';
    await expect(withBackgroundWorktreeNote(Promise.resolve(ok), Promise.resolve(note), 'agent-1'))
      .resolves.toMatchObject({ output: `report body${note}` });
    const failed = { success: false, error: 'boom' } as unknown as SubagentResult;
    await expect(withBackgroundWorktreeNote(Promise.resolve(failed), Promise.resolve(note), 'agent-1'))
      .resolves.toMatchObject({ error: `boom${note}` });
  });

  it('does not hang the completion when the cleanup never settles', async () => {
    vi.useFakeTimers();
    const pending = withBackgroundWorktreeNote(Promise.resolve(ok), new Promise<string>(() => {}), 'agent-1');
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toBe(ok);
  });

  it('wires the settled note into the adopted foreground spawn (static contract)', () => {
    const source = readFileSync('src/host/agent/multiagentTools/spawnSingleAgent.ts', 'utf8');
    expect(source).toMatch(/onSettled: settleWorktreeNote/);
    expect(source).toMatch(/adoptForegroundSubagent\(\{\s*promise: worktreeInfo \? withBackgroundWorktreeNote\(promise, worktreeNoteSettled, agentId\) : promise/);
  });
});
