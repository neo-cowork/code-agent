// 真实 git：分支命名 + 清理/丢弃/孤儿清理读 worktree 真实分支
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const rnd = vi.hoisted(() => ({ queue: [] as string[] }));
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    randomBytes: (n: number) =>
      rnd.queue.length ? Buffer.from(rnd.queue.shift()!, 'hex') : actual.randomBytes(n),
  };
});

import {
  createAgentWorktree,
  cleanupAgentWorktree,
  discardAgentWorktree,
  cleanupOrphanedWorktrees,
} from '../../../src/host/agent/agentWorktree';

const UUID = '3f2a1b4c-1111-4222-8333-444455556666';
const git = (cwd: string, cmd: string) => execSync(`git ${cmd}`, { cwd, encoding: 'utf8' });
const branches = (repo: string) => git(repo, `branch --list 'agent/*' --format='%(refname:short)'`).trim();

describe('agent worktree branch naming (real git)', () => {
  let repo: string;
  const created: string[] = [];

  beforeEach(() => {
    rnd.queue.length = 0;
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-branch-'));
    git(repo, 'init -q -b main');
    git(repo, 'config user.email t@t.t');
    git(repo, 'config user.name t');
    fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
    git(repo, 'add -A');
    git(repo, 'commit -q -m init');
  });

  afterEach(() => {
    for (const p of created.splice(0)) fs.rmSync(p, { recursive: true, force: true });
    try { git(repo, 'worktree prune'); } catch { /* ignore */ }
    fs.rmSync(repo, { recursive: true, force: true });
  });

  async function make(id: string, label?: string) {
    const info = await createAgentWorktree(id, repo, undefined, label);
    created.push(info.worktreePath);
    return info;
  }

  it('① naming samples: English / Chinese / empty / long / collision retry', async () => {
    const samples: Record<string, string> = {};
    rnd.queue.push('3f2a');
    samples.english = (await make(`agent_coder_${UUID}`, 'Update the README intro to two sentences')).branchName;
    rnd.queue.push('aaaa');
    samples.chinese = (await make(`agent_coder_${UUID.replace('3f2a', '3f2b')}`, '把简介改成两句话')).branchName;
    rnd.queue.push('bbbb');
    samples.empty = (await make(`agent_reviewer_${UUID.replace('3f2a', '3f2c')}`, '')).branchName;
    rnd.queue.push('cccc');
    samples.long = (await make(`agent_coder_${UUID.replace('3f2a', '3f2d')}`,
      'refactorization of internationalization infrastructure across every package')).branchName;
    // collision: 3f2a already exists as agent/update-readme-intro-two-3f2a → first draw collides
    rnd.queue.push('3f2a', 'dddd');
    samples.collision = (await make(`agent_coder_${UUID.replace('3f2a', '3f2e')}`, 'Update the README intro to two sentences')).branchName;
    console.log('BRANCH SAMPLES', JSON.stringify(samples, null, 2));

    expect(samples.english).toBe('agent/update-readme-intro-two-3f2a');
    expect(samples.chinese).toBe('agent/coder-aaaa');
    expect(samples.empty).toBe('agent/reviewer-bbbb');
    expect(samples.long).toBe('agent/refactorization-cccc');
    expect(samples.collision).toBe('agent/update-readme-intro-two-dddd');
    for (const b of Object.values(samples)) expect(b).not.toContain('agent_');
  });

  it('drops path-like tokens and noise words from the task text', async () => {
    rnd.queue.push('1234');
    const info = await make(`agent_coder_${UUID.replace('3f2a', '3f2f')}`,
      'In /Users/someone/work/proj please have a sub-agent do this in an isolated git worktree: rewrite README.md intro');
    expect(info.branchName).toBe('agent/rewrite-readme-md-intro-1234');
    expect(path.basename(info.worktreePath)).toBe('rewrite-readme-md-intro-1234');
  });

  it('skips filler words of model-written task prompts', async () => {
    rnd.queue.push('0001');
    const info = await make(`agent_coder_${UUID.replace('3f2a', '3f20')}`,
      'You are given a git repo at the working directory. Rewrite the intro in README.md');
    expect(info.branchName).toBe('agent/rewrite-intro-readme-md-0001');
  });

  it('real model-written sub-task texts from the real run give task-related slugs', async () => {
    rnd.queue.push('b7a2', '8929');
    const a = await make(`agent_coder_${UUID.replace('3f2a', '3f21')}`,
      "Work ONLY inside the isolated git worktree you were given (NOT the user's main checkout at /Users/leo/work/wt/x).\n\nTask:\n1. Confirm your current working directory / worktree root path and the branch name it is on. Report both.\n2. Read README.md in that worktree.\n3. Rewrite ONLY the intro section (the opening paragraph(s) right after the title) so that it is exactly two sentences.");
    expect(a.branchName).toBe('agent/rewrite-intro-section-b7a2');
    const b = await make(`agent_coder_${UUID.replace('3f2a', '3f22')}`,
      "You are working in an isolated git worktree. Do NOT touch the user's main checkout working tree.\n\nSteps, in order:\n1. Print and report your worktree root (`pwd`) and branch.\n2. Read README.md. Its intro (line 3) currently reads: \"Notes App is a tool.\"\n3. Replace ONLY that intro paragraph with exactly two sentences.");
    expect(b.branchName).toBe('agent/replace-intro-paragraph-8929');
  });

  it('non-internal ids without label keep the legacy name', async () => {
    const info = await make('agent-1');
    expect(info.branchName).toBe('agent/agent-1');
  });

  it('③ cleanup deletes the real (new-style) branch when there are no changes', async () => {
    const info = await make(`agent_coder_${UUID}`, 'fix typo');
    expect(branches(repo)).toContain(info.branchName);
    const res = await cleanupAgentWorktree(`agent_coder_${UUID}`, info.worktreePath, repo, info.baseCommit);
    expect(res.hasChanges).toBe(false);
    expect(res.branchName).toBe(info.branchName);
    expect(branches(repo)).toBe('');
  });

  it('③ cleanup keeps the branch + reports it when changes exist (restart: no in-memory state)', async () => {
    const id = `agent_coder_${UUID}`;
    const info = await make(id, 'rewrite intro');
    fs.writeFileSync(path.join(info.worktreePath, 'README.md'), 'new\n');
    vi.resetModules(); // simulate restart: fresh module state, only the on-disk worktree remains
    const fresh = await import('../../../src/host/agent/agentWorktree');
    const res = await fresh.cleanupAgentWorktree(id, info.worktreePath, repo, info.baseCommit);
    expect(res.hasChanges).toBe(true);
    expect(res.branchName).toBe(info.branchName);
    expect(branches(repo)).toBe(info.branchName);
  });

  it('③ discard removes the real new-style branch', async () => {
    const id = `agent_coder_${UUID}`;
    const info = await make(id, 'rewrite intro');
    await discardAgentWorktree(id, info.worktreePath, repo);
    expect(branches(repo)).toBe('');
  });

  it('③ legacy agent/agent_* branch is still cleaned by cleanup and discard', async () => {
    const id = `agent_coder_${UUID}`;
    const legacyPath = path.join(os.tmpdir(), 'code-agent-worktrees', `legacy_${Date.now()}`);
    git(repo, `worktree add -b agent/${id} ${legacyPath} HEAD`);
    created.push(legacyPath);
    const res = await cleanupAgentWorktree(id, legacyPath, repo, undefined);
    expect(res.hasChanges).toBe(false);
    expect(branches(repo)).toBe('');
    const p2 = path.join(os.tmpdir(), 'code-agent-worktrees', `legacy2_${Date.now()}`);
    git(repo, `worktree add -b agent/${id} ${p2} HEAD`);
    created.push(p2);
    await discardAgentWorktree(id, p2, repo);
    expect(branches(repo)).toBe('');
  });

  it('③ orphan cleanup removes both new-style and legacy branches', async () => {
    const info = await make(`agent_coder_${UUID}`, 'old task');
    const legacyPath = path.join(os.tmpdir(), 'code-agent-worktrees', `orph_${Date.now()}`);
    git(repo, `worktree add -b agent/agent_coder_legacy ${legacyPath} HEAD`);
    created.push(legacyPath);
    const old = new Date(Date.now() - 10 * 3_600_000);
    fs.utimesSync(info.worktreePath, old, old);
    fs.utimesSync(legacyPath, old, old);
    const n = await cleanupOrphanedWorktrees(repo, 3_600_000);
    expect(n).toBe(2);
    expect(branches(repo)).toBe('');
  });
});
