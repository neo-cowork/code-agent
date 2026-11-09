import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubagentContextStore } from '../../../src/host/context/subagentContextStore';
import { getSpawnGuard, resetSpawnGuard } from '../../../src/host/agent/spawnGuard';
import { buildAgentTreeSnapshot } from '../../../src/host/agent/agentTreeService';

const holder = vi.hoisted(() => ({ store: undefined as unknown }));
vi.mock('../../../src/host/context/subagentContextStore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSubagentContextStore: () => holder.store,
}));

describe('SpawnGuard records the terminal status for the agent panel', () => {
  let store: SubagentContextStore;
  const storePath = () => path.join(mkdtempSync(path.join(tmpdir(), 'ctx-store-')), 'store.json');

  beforeEach(() => {
    resetSpawnGuard();
    store = new SubagentContextStore(storePath());
    holder.store = store;
  });

  it('a helper that finished successfully is still completed after a restart reload', async () => {
    store.upsert({ sessionId: 's1', agentId: 'agent_explore_x', messages: [], updatedAt: Date.now() - 60_000 });
    let resolve!: (value: { success: boolean; output: string; toolsUsed: string[]; iterations: number }) => void;
    const promise = new Promise<{ success: boolean; output: string; toolsUsed: string[]; iterations: number }>((r) => { resolve = r; });
    getSpawnGuard().register('agent_explore_x', 'explore', 'task', promise, new AbortController(), { treeId: 's1' });
    resolve({ success: true, output: 'ok', toolsUsed: [], iterations: 1 });
    await promise;
    await Promise.resolve();

    // New process: the guard is empty and only the persisted record survives (written before this process booted).
    resetSpawnGuard();
    const snapshot = buildAgentTreeSnapshot({ sessionId: 's1', contextRecords: store.list('s1') });
    expect(snapshot.nodes.find((n) => n.id === 'agent_explore_x')?.status).toBe('completed');
  });
});
