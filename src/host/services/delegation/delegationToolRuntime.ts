import crypto from 'node:crypto';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import type { ModelConfig } from '../../../shared/contract/model';
import type { SessionCandidateRow } from './delegationCandidates';
import type { DelegationSessionRowLike } from './delegationDelivery';
import { getDatabase } from '../core/databaseService';
import { getApplicationRunRegistry } from '../../app/applicationRunRegistry';
import { getSessionManager } from '../infra/sessionManager';
import { getProjectService } from '../project/projectService';
import { getPermissionModeManager } from '../../permissions/modes';
import { evaluateFolderTrustForDelegation } from './delegationFolderTrust';
import type { WorkspaceScope } from '../../../shared/contract/project';
import { notifyDelegationEnqueued } from './delegationEnqueueSignal';

interface DelegationRunSummary {
  context: { sessionId: string; runId?: string; workspace?: string; workspaceScope?: WorkspaceScope };
  cancel?(reason: 'user'): void | Promise<void>;
}

export interface DelegationToolRuntime {
  getDb(): BetterSqlite3.Database | null;
  listSessions(): SessionCandidateRow[];
  getSessionRow(sessionId: string): (DelegationSessionRowLike & {
    id?: string;
    title?: string;
    modelConfig?: ModelConfig;
    projectId?: string | null;
    updatedAt?: number;
  }) | null;
  getRuns(): DelegationRunSummary[];
  getRun(sessionId: string): DelegationRunSummary | undefined;
  getPermissionMode(sessionId: string): string | null;
  evaluateFolderTrust(workingDirectory: string): Promise<{ state: string; blockedItems: number }>;
  getWorkspaceRoots(): string[];
  getSessionManager(): Pick<ReturnType<typeof getSessionManager>, 'createSession'>;
  notifyEnqueued(sessionId: string): void;
  now(): number;
  randomId(prefix: string): string;
}

function sessionRow(sessionId: string) {
  try {
    const row = getDatabase().getSession(sessionId, { includeDeleted: true });
    return row
      ? {
        ...row,
        id: row.id,
        title: row.title,
        modelConfig: row.modelConfig,
        projectId: row.projectId,
        updatedAt: row.updatedAt,
        sessionType: row.type,
        engineKind: row.engine?.kind,
        workingDirectory: row.workingDirectory ?? null,
        isArchived: row.status === 'archived',
        isDeleted: Boolean(row.isDeleted),
      }
      : null;
  } catch {
    return null;
  }
}

function workspaceRoots(): string[] {
  try {
    const projects = getProjectService().listProjects(true);
    const roots = projects.flatMap((project) => {
      const root = project.workspacePath?.trim();
      return root ? [root] : [];
    });
    return [...new Set(roots)];
  } catch {
    return [];
  }
}

/** 用户发起本轮的消息正文（sourceMessageId 优先，缺省取会话最近一条 user 消息）；拿不到 → null。 */
export function readOriginUserMessage(db: BetterSqlite3.Database | null, sessionId: string, sourceMessageId?: string): string | null {
  if (!db) return null;
  try {
    const byId = sourceMessageId
      ? db.prepare(`SELECT content FROM messages WHERE id = ? AND session_id = ? AND role = 'user'`).get(sourceMessageId, sessionId) as { content?: unknown } | undefined
      : undefined;
    const row = byId ?? db.prepare(
      `SELECT content FROM messages WHERE session_id = ? AND role = 'user' AND is_meta = 0 AND visibility = 'active' ORDER BY timestamp DESC, rowid DESC LIMIT 1`,
    ).get(sessionId) as { content?: unknown } | undefined;
    return typeof row?.content === 'string' && row.content.trim() !== '' ? row.content : null;
  } catch {
    return null;
  }
}

export function workspaceWithinRoots(workspace: string | null | undefined, roots: readonly string[]): boolean {
  if (!workspace) return false;
  const resolved = path.resolve(workspace);
  return roots.some((root) => {
    const base = path.resolve(root);
    return resolved === base || resolved.startsWith(`${base}${path.sep}`);
  });
}

const candidateSecret = crypto.randomBytes(32).toString('hex');

export function getDelegationCandidateSecret(): string {
  return candidateSecret;
}

export function getDelegationToolRuntime(context?: unknown): DelegationToolRuntime {
  const registry = getApplicationRunRegistry();
  const runtime: DelegationToolRuntime = {
    getDb: () => getDatabase().getDb(),
    listSessions: () => getDatabase().listSessions(10_000, 0, false).map((session) => ({
      id: session.id,
      title: session.title,
      workingDirectory: session.workingDirectory,
      updatedAt: session.updatedAt,
      sessionType: session.type,
      isArchived: session.status === 'archived',
      isDeleted: Boolean(session.isDeleted),
      engineKind: session.engine?.kind,
    })),
    getSessionRow: sessionRow,
    getRuns: () => registry.list().map((handle) => ({ context: handle.context, cancel: (reason: 'user') => handle.cancel(reason) })),
    getRun: (sessionId) => {
      const handle = registry.getBySessionId(sessionId);
      return handle ? { context: handle.context, cancel: (reason: 'user') => handle.cancel(reason) } : undefined;
    },
    getPermissionMode: (sessionId) => {
      try {
        return getPermissionModeManager().getModeForSession(sessionId);
      } catch {
        return 'unresolved';
      }
    },
    evaluateFolderTrust: (workingDirectory) => evaluateFolderTrustForDelegation(workingDirectory),
    getWorkspaceRoots: workspaceRoots,
    getSessionManager: () => getSessionManager(),
    notifyEnqueued: notifyDelegationEnqueued,
    now: () => Date.now(),
    randomId: (prefix) => `${prefix}${crypto.randomUUID()}`,
  };
  const contextRuntime = context && typeof context === 'object'
    ? (context as { delegationRuntime?: Partial<DelegationToolRuntime> }).delegationRuntime
    : undefined;
  return { ...runtime, ...(contextRuntime ?? {}) };
}
