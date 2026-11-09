import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import type { CanUseToolFn, ToolContext } from '../../../src/host/protocol/tools';
import type { SubagentExecutionRequest, SubagentResult } from '../../../src/host/agent/subagentExecutorTypes';

vi.mock('../../../src/host/context/subagentContextStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/context/subagentContextStore')>();
  const fs = await import('node:fs');
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'helper-snapshot-'));
  const store = new actual.SubagentContextStore(nodePath.join(dir, 'contexts.json'));
  return { ...actual, getSubagentContextStore: () => store };
});

import { getAgentTreeSnapshot } from '../../../src/host/agent/agentTreeService';
import { getBackgroundSubagentRegistry } from '../../../src/host/agent/backgroundSubagentRegistry';
import { getSpawnGuard, resetSpawnGuard } from '../../../src/host/agent/spawnGuard';
import { withPersistedSubagentLifecycle } from '../../../src/host/agent/subagentContextLifecycle';
import { getSubagentContextStore, SubagentContextStore } from '../../../src/host/context/subagentContextStore';
import { executeTaskStatus } from '../../../src/host/tools/modules/commandCenter/sessionCommandCenter';

const allow: CanUseToolFn = async () => ({ allow: true });
let sequence = 0;
const sessions = new Set<string>();
const diskDir = mkdtempSync(path.join(tmpdir(), 'helper-restart-'));
function context(sessionId: string): ToolContext {
  return {
    sessionId, workingDir: '/tmp/helper-notes', abortSignal: new AbortController().signal,
    emit: () => undefined,
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };
}
function result(success = true): SubagentResult {
  return { success, output: success ? 'Notes summarized' : '', toolsUsed: ['Read'], iterations: 2,
    ...(success ? {} : { error: 'read failed' }) };
}
function startHelper(sessionId: string, name: string, registryWrapped: boolean) {
  const agentId = `agent_explore_snapshot_${++sequence}`;
  const backgroundAgentId = registryWrapped ? `subagent-bg-snapshot-${sequence}` : undefined;
  let resolve!: (value: SubagentResult) => void;
  const pending = new Promise<SubagentResult>((done) => { resolve = done; });
  const request: SubagentExecutionRequest = {
    prompt: `Summarize ${name} folder notes`,
    config: { name, roleId: 'explore', systemPrompt: 'Summarize notes.', availableTools: ['Read'] },
    context: {
      sessionId, agentId, executionAgentId: agentId, spawnGuardId: agentId,
      resolver: { getDefinition: () => undefined }, abortSignal: new AbortController().signal,
      cwd: '/tmp/helper-notes', modelConfig: { provider: 'test', model: 'test-model' },
      permission: { request: async () => true },
      events: { emit: () => undefined, detached: true, backgroundDurableAgentId: backgroundAgentId },
    },
  };
  const promise = withPersistedSubagentLifecycle(request, () => pending);
  getSpawnGuard().register(agentId, 'explore', request.prompt, promise, new AbortController(), {
    treeId: sessionId, completion: { title: name, kind: 'user_visible' },
  });
  if (backgroundAgentId) getBackgroundSubagentRegistry().adopt(promise, {
    agentId: backgroundAgentId, sessionId, role: 'explore', title: request.prompt,
  });
  sessions.add(sessionId);
  return { agentId, backgroundAgentId, promise, resolve };
}
function session() { return `helper-snapshot-session-${++sequence}`; }
afterEach(() => {
  resetSpawnGuard();
  for (const id of sessions) getSubagentContextStore().clearSession(id);
  sessions.clear();
});
afterAll(() => rmSync(diskDir, { recursive: true, force: true }));

for (const wrapped of [true, false]) {
  it(`${wrapped ? 'run_in_background:true' : 'waitForCompletion:false'} is terminal between turns, exactly once and identical to the panel`, async () => {
    const id = session();
    const helper = startHelper(id, '总结B', wrapped);
    if (!wrapped) expect(getBackgroundSubagentRegistry().listBySession(id)).toEqual([]);
    const first = await executeTaskStatus({}, context(id), allow);
    expect(first.ok && first.output).toContain('总结B [running]');
    expect(first.ok && first.output).toContain('No remaining-time data exists. Do not estimate an ETA.');
    // The executor publishes fresh context independently of lifecycle recording.
    const record = getSubagentContextStore().get(id, helper.agentId)!;
    const { lifecycle: _lifecycle, ...snapshotUpdate } = record;
    getSubagentContextStore().upsert(snapshotUpdate);
    helper.resolve(result());
    await helper.promise;
    await vi.waitFor(() => expect(getSpawnGuard().get(helper.agentId)?.status).toBe('completed'));
    const panel = getAgentTreeSnapshot({ sessionId: id });
    expect(panel.nodes).toHaveLength(1);
    expect(panel.nodes[0]).toMatchObject({ id: helper.agentId, displayName: '总结B', status: 'completed', background: true });
    const second = await executeTaskStatus({}, context(id), allow);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error);
    expect(second.output.match(/\[completed\]/g)).toHaveLength(1);
    expect(second.output).toContain(`总结B [completed] id=${panel.nodes[0].id} duration=`);
    expect(second.output).not.toContain('[running]');
    expect(second.output).not.toContain('No remaining-time');
    console.log('snapshot proof', JSON.stringify({ variant: wrapped ? 'run_in_background:true' : 'waitForCompletion:false', first: first.ok ? first.output : first.error, second: second.output, panel: panel.nodes.map(({ id, status, sources }) => ({ id, status, sources })) }));
  });
}

it('same-role helpers keep their spawn names and exclude another session and foreground helper', async () => {
  const id = session();
  const a = startHelper(id, '总结A', true);
  const b = startHelper(id, '总结B', false);
  const other = startHelper(session(), 'Other session', false);
  const foregroundId = 'foreground-helper';
  getSpawnGuard().register(foregroundId, 'explore', 'Foreground work', Promise.resolve(result()), new AbortController(), { treeId: id });
  const read = await executeTaskStatus({}, context(id), allow);
  expect(read.ok && read.output).toContain('总结A [running]');
  expect(read.ok && read.output).toContain('总结B [running]');
  expect(read.ok && read.output).not.toContain('Other session');
  expect(read.ok && read.output).not.toContain(foregroundId);
  for (const helper of [a, b, other]) helper.resolve(result());
  await Promise.all([a.promise, b.promise, other.promise]);
});

it.each(['completed', 'failed', 'cancelled'] as const)('persisted %s beats the boot-time heuristic with a real disk record', async (status) => {
  const id = session();
  const helper = startHelper(id, '总结B', false);
  helper.resolve(status === 'completed' ? result() : { ...result(false), ...(status === 'cancelled' ? { cancellationReason: 'user-cancel' as const } : {}) });
  await helper.promise;
  const persisted = getSubagentContextStore().get(id, helper.agentId)!;
  const file = path.join(diskDir, `${status}.json`);
  const disk = new SubagentContextStore(file);
  const beforeBoot = Date.now() - process.uptime() * 1000 - 1000;
  disk.upsert({ ...persisted, updatedAt: beforeBoot, lifecycle: { ...persisted.lifecycle!, startedAt: beforeBoot - 44000, finishedAt: beforeBoot } });
  const reloaded = new SubagentContextStore(file).get(id, helper.agentId)!;
  resetSpawnGuard();
  getSubagentContextStore().upsert(reloaded);
  const snapshot = getAgentTreeSnapshot({ sessionId: id });
  expect(snapshot.nodes).toHaveLength(1);
  expect(snapshot.nodes[0].status).toBe(status);
  const read = await executeTaskStatus({}, context(id), allow);
  expect(read.ok && read.output).toContain(`总结B [${status}]`);
  expect(read.ok && read.output).toContain('duration=44 s');
});

it('unfinished old contexts remain cancelled, never resurrected by the new lifecycle fields', async () => {
  const id = session();
  const beforeBoot = Date.now() - process.uptime() * 1000 - 1000;
  getSubagentContextStore().upsert({ sessionId: id, agentId: 'orphan', messages: [], updatedAt: beforeBoot,
    lifecycle: { status: 'running', displayName: 'Interrupted helper', task: 'Read notes', background: true, startedAt: beforeBoot } });
  expect(getAgentTreeSnapshot({ sessionId: id }).nodes[0].status).toBe('cancelled');
});
