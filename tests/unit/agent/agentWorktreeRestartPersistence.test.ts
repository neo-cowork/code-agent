// 真实 git：重启后 preserved worktree 产物经落盘恢复，委派卡片仍有「改动在分支」行
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolCall } from '../../../src/shared/contract';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/services/infra/logger')>()),
  createLogger: () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() }),
}));

const git = (cwd: string, cmd: string) => execSync(`git ${cmd}`, { cwd, encoding: 'utf8' });
const AGENT_ID = 'agent_coder_3f2a1b4c-1111-4222-8333-444455556666';
const SESSION = 'session-restart';

describe('agent worktree artifacts survive restart (real git)', () => {
  let repo: string;
  let dataDir: string;
  let worktreePath: string;
  let branch: string;
  const prevDataDir = process.env.CODE_AGENT_DATA_DIR;

  beforeEach(async () => {
    warn.mockClear();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-restart-data-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    vi.resetModules();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-restart-'));
    git(repo, 'init -q -b main');
    git(repo, 'config user.email t@t.t');
    git(repo, 'config user.name t');
    fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
    git(repo, 'add -A');
    git(repo, 'commit -q -m init');

    const wt = await import('../../../src/host/agent/agentWorktree');
    const info = await wt.createAgentWorktree(AGENT_ID, repo, undefined, 'Add a contributing guide');
    worktreePath = info.worktreePath;
    branch = info.branchName;
    fs.writeFileSync(path.join(worktreePath, 'CONTRIBUTING.md'), 'guide\n');
    const result = await wt.cleanupAgentWorktree(AGENT_ID, worktreePath, repo, info.baseCommit);
    expect(result.hasChanges).toBe(true);
  });

  afterEach(() => {
    try { git(repo, 'worktree prune'); } catch { /* ignore */ }
    fs.rmSync(worktreePath, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (prevDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = prevDataDir;
  });

  /** Simulate a process restart: fresh module graph (empty in-memory Map), same data dir. */
  async function restart() {
    vi.resetModules();
    const store = await import('../../../src/host/context/subagentContextStore');
    store.getSubagentContextStore().upsert({
      sessionId: SESSION,
      agentId: AGENT_ID,
      messages: [],
      lifecycleStatus: 'completed',
      terminalStatus: 'completed',
      lifecycle: {
        status: 'completed',
        displayName: 'coder',
        role: 'coder',
        task: 'Add a contributing guide',
        background: false,
        startedAt: Date.now() - 2000,
        finishedAt: Date.now() - 1000,
      },
      updatedAt: Date.now(),
    });
    const tree = await import('../../../src/host/agent/agentTreeService');
    const snapshot = tree.getAgentTreeSnapshot({ sessionId: SESSION });
    const node = snapshot.nodes.find((n) => n.id === AGENT_ID);
    return { node };
  }

  async function branchRow(node: unknown): Promise<string | undefined> {
    const { deriveDelegationPresentation } = await import(
      '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation'
    );
    const toolCall = {
      id: 'tc-1',
      name: 'spawn_agent',
      arguments: { role: 'coder', task: 'Add a contributing guide' },
      result: { toolCallId: 'tc-1', success: true, output: 'done', metadata: { agentId: AGENT_ID } },
    } as unknown as ToolCall;
    return deriveDelegationPresentation(toolCall, [], [node as never])?.branch;
  }

  it('restores worktreeState and the card branch row after restart', async () => {
    const file = path.join(dataDir, 'agent-worktree-artifacts.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).artifacts).toHaveLength(1);
    const { node } = await restart();
    expect(node?.worktreeState.status).toBe('preserved');
    expect(node?.worktreeState.branch).toBe(branch);
    expect(await branchRow(node)).toBe(branch);
  });

  it('no branch row after the branch was deleted', async () => {
    git(repo, `worktree remove --force ${worktreePath}`);
    git(repo, `branch -D ${branch}`);
    const { node } = await restart();
    expect(node?.worktreeState.status).toBe('none');
    expect(await branchRow(node)).toBeUndefined();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('path-missing'))).toBe(true);
  });

  it('no branch row (branch-missing) when only the branch is gone', async () => {
    git(repo, `worktree remove --force ${worktreePath}`);
    fs.mkdirSync(worktreePath, { recursive: true });
    git(repo, `branch -D ${branch}`);
    const { node } = await restart();
    expect(await branchRow(node)).toBeUndefined();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('branch-missing'))).toBe(true);
  });

  it('no branch row after the worktree dir was removed', async () => {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    const { node } = await restart();
    expect(await branchRow(node)).toBeUndefined();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('path-missing'))).toBe(true);
  });

  it('no branch row when worktree is clean and the branch is merged into HEAD', async () => {
    git(worktreePath, 'add -A');
    git(worktreePath, 'commit -q -m guide');
    git(repo, `merge -q ${branch}`);
    const { node } = await restart();
    expect(await branchRow(node)).toBeUndefined();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('already-merged'))).toBe(true);
  });

  it('keeps the row when the branch has unmerged commits and a clean worktree', async () => {
    git(worktreePath, 'add -A');
    git(worktreePath, 'commit -q -m guide');
    const { node } = await restart();
    expect(await branchRow(node)).toBe(branch);
  });

  it('does not create a phantom unknown node for a hydrated artifact without a lifecycle record', async () => {
    vi.resetModules();
    const tree = await import('../../../src/host/agent/agentTreeService');
    // no context record at all (pruned, or belongs to another session)
    const snapshot = tree.getAgentTreeSnapshot({ sessionId: SESSION });
    expect(snapshot.nodes.find((n) => n.id === AGENT_ID)).toBeUndefined();
    const other = tree.getAgentTreeSnapshot({ sessionId: 'another-session' });
    expect(other.nodes.find((n) => n.id === AGENT_ID)).toBeUndefined();
  });

  it('no branch row after discard (cleaned artifact)', async () => {
    const wt = await import('../../../src/host/agent/agentWorktree');
    await wt.discardAgentWorktree(AGENT_ID, worktreePath, repo);
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-worktree-artifacts.json'), 'utf8'));
    expect(persisted.artifacts).toHaveLength(0);
    const { node } = await restart();
    expect(await branchRow(node)).toBeUndefined();
  });
});
