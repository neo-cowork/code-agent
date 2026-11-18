// Persist preserved-worktree artifacts so "changes are on branch X" survives a restart.
import path from 'path';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { getPath } from '../platform/appPaths';
import { createLogger } from '../services/infra/logger';
import type { AgentWorktreeArtifact } from '../../shared/contract/agentTree';

const logger = createLogger('AgentWorktreeStore');
const STORE_FILE_NAME = 'agent-worktree-artifacts.json';

interface PersistedWorktreeArtifacts {
  version: 1;
  artifacts: AgentWorktreeArtifact[];
}

let cachedFilePath: string | null = null;

function getStorePath(): string {
  if (!cachedFilePath) cachedFilePath = path.join(getPath('userData'), STORE_FILE_NAME);
  return cachedFilePath;
}

export function resetAgentWorktreeStoreForTest(): void {
  cachedFilePath = null;
}

/** Rewrite the file with exactly the `preserved` artifacts. Never throws. */
export function persistPreservedArtifacts(artifacts: Iterable<AgentWorktreeArtifact>): void {
  const filePath = getStorePath();
  try {
    const payload: PersistedWorktreeArtifacts = {
      version: 1,
      artifacts: Array.from(artifacts).filter((a) => a.status === 'preserved'),
    };
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (error) {
    logger.warn('Failed to persist agent worktree artifacts', { error, path: filePath });
  }
}

function git(cwd: string, args: string[], timeout: number): string {
  return execFileSync('git', args, { cwd, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitSucceeds(cwd: string, args: string[], timeout: number): boolean | undefined {
  try {
    execFileSync('git', args, { cwd, timeout, stdio: 'ignore' });
    return true;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    // Plain non-zero exit = a definite "no"; anything else (timeout/ENOENT) is unknown.
    return typeof status === 'number' ? false : undefined;
  }
}

type DropReason = 'path-missing' | 'branch-missing' | 'already-merged';

function staleReason(a: AgentWorktreeArtifact, timeout: number): DropReason | undefined {
  if (!a.path || !existsSync(a.path)) return 'path-missing';
  const repoPath = a.repoPath;
  if (!a.branch || !repoPath) return undefined;
  try {
    const branchExists = gitSucceeds(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${a.branch}`], timeout);
    if (branchExists === false) return 'branch-missing';
    if (branchExists === undefined) return undefined;
    const clean = git(a.path, ['status', '--porcelain'], timeout).trim() === '';
    if (!clean) return undefined;
    const merged = gitSucceeds(repoPath, ['merge-base', '--is-ancestor', `refs/heads/${a.branch}`, 'HEAD'], timeout);
    return merged ? 'already-merged' : undefined;
  } catch (error) {
    logger.warn('Worktree artifact stale check failed; keeping entry', { agentId: a.agentId, error });
    return undefined;
  }
}

/** Load persisted artifacts, dropping stale ones (and rewriting the file when any dropped). */
export function loadPersistedArtifacts(timeout: number): AgentWorktreeArtifact[] {
  const filePath = getStorePath();
  if (!existsSync(filePath)) return [];
  let parsed: PersistedWorktreeArtifacts;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as PersistedWorktreeArtifacts;
  } catch (error) {
    logger.warn('Failed to read agent worktree artifacts', { error, path: filePath });
    return [];
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.artifacts)) return [];
  const kept: AgentWorktreeArtifact[] = [];
  for (const a of parsed.artifacts) {
    if (!a || typeof a.agentId !== 'string' || a.status !== 'preserved') continue;
    const reason = staleReason(a, timeout);
    if (reason) {
      logger.warn(`Dropping stale worktree artifact (${reason})`, {
        agentId: a.agentId,
        branch: a.branch,
        path: a.path,
        reason,
      });
      continue;
    }
    kept.push(a);
  }
  if (kept.length !== parsed.artifacts.length) persistPreservedArtifacts(kept);
  return kept;
}
