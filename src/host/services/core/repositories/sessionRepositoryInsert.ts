import type BetterSqlite3 from 'better-sqlite3';
import type { Session, ModelProvider } from '../../../../shared/contract';
import { normalizeAgentEngineSession } from '../../../../shared/contract/agentEngine';
import { normalizeStoredTimestamp } from './sessionRepositoryParsers';
import { assertRemoteSessionBoundaryCompatible } from './sessionRepositoryBoundary';
import { humanizeStoredName } from '../../../session/humanizeStoredName';

export function insertSessionWithId(
    db: BetterSqlite3.Database,
    syncedAt: number | null,
    id: string,
    data: {
      title: string;
      userId?: string | null;
      modelConfig: { provider: ModelProvider; model: string };
      workingDirectory?: string;
      projectId?: string | null;
      type?: Session['type'];
      origin?: Session['origin'];
      parentSessionId?: string;
      sourceRunId?: string;
      engine?: Session['engine'];
      metadata?: Session['metadata'];
      readOnly?: boolean;
      retryOfSessionId?: string;
      createdAt?: number | string;
      updatedAt?: number | string;
      isDeleted?: boolean;
    },
    options?: { syncOrigin?: 'local' | 'remote' },
  ): void {
    const title = humanizeStoredName(data.title);
    const now = Date.now();
    const createdAt = normalizeStoredTimestamp(data.createdAt, now);
    const updatedAt = normalizeStoredTimestamp(data.updatedAt, createdAt);
    // 云端同步（syncOrigin='remote'）走幂等 upsert：本地可能已存在同 id 但 user_id 为
    // NULL/不同（按 owner 过滤的 getSession 查不到 → 误判为不存在），纯 INSERT 会撞主键
    // UNIQUE 报错且每轮同步刷屏，这些会话也永远认领不到当前用户 → 列表里不显示。
    // 冲突时校准 user_id（认领归属）+ 云端元数据，保留 created_at 与本地专属字段。
    // 非同步的本地新建仍走严格 INSERT（id 总是新生成，撞 id 视为真 bug 应暴露）。
    const conflictClause =
      options?.syncOrigin === 'remote'
        ? `ON CONFLICT(id) DO UPDATE SET
            user_id = excluded.user_id,
            title = excluded.title,
            model_provider = excluded.model_provider,
            model_name = excluded.model_name,
            working_directory = excluded.working_directory,
            project_id = excluded.project_id,
            updated_at = excluded.updated_at,
            is_deleted = excluded.is_deleted,
            synced_at = excluded.synced_at`
        : '';
    const stmt = db.prepare(`
        INSERT INTO sessions (
          id, user_id, title, model_provider, model_name, working_directory,
          session_type, origin, metadata, parent_session_id, source_run_id, agent_engine, read_only, retry_of_session_id,
          created_at, updated_at, is_deleted, synced_at, project_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ${conflictClause}
    `);

    db.transaction(() => {
      if (options?.syncOrigin === 'remote') {
        assertRemoteSessionBoundaryCompatible(db, id, {
          ownerUserId: data.userId ?? null,
          projectId: data.projectId ?? null,
        });
      }
      stmt.run(
        id,
        data.userId ?? null,
        title,
        data.modelConfig.provider,
        data.modelConfig.model,
        data.workingDirectory || null,
        data.type || 'chat',
        data.origin ? JSON.stringify(data.origin) : null,
        data.metadata ? JSON.stringify(data.metadata) : null,
        data.parentSessionId || null,
        data.sourceRunId || null,
        data.engine ? JSON.stringify(normalizeAgentEngineSession(data.engine)) : null,
        data.readOnly ? 1 : 0,
        data.retryOfSessionId || null,
        createdAt,
        updatedAt,
        data.isDeleted ? 1 : 0,
        syncedAt,
        data.projectId ?? null,
      );
    })();
    data.title = title;
  }


export function insertSession(db: BetterSqlite3.Database, session: Session): void {
    const title = humanizeStoredName(session.title);
    const stmt = db.prepare(`
        INSERT INTO sessions (
          id, user_id, title, model_provider, model_name, working_directory,
          session_type, origin, metadata, parent_session_id, source_run_id, agent_engine, memory_mode,
          suppressed_memory_entry_ids, read_only, retry_of_session_id,
          created_at, updated_at, workspace, workbench_provenance, status, last_token_usage,
          is_deleted, synced_at, git_branch, project_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
    `);

    db.transaction(() => {
      stmt.run(
        session.id,
        session.userId ?? null,
        title,
        session.modelConfig.provider,
        session.modelConfig.model,
        session.workingDirectory || null,
        session.type || 'chat',
        session.origin ? JSON.stringify(session.origin) : null,
        session.metadata ? JSON.stringify(session.metadata) : null,
        session.parentSessionId || null,
        session.sourceRunId || null,
        session.engine ? JSON.stringify(normalizeAgentEngineSession(session.engine)) : null,
        session.memoryMode || 'auto',
        JSON.stringify(session.suppressedMemoryEntryIds || []),
        session.readOnly ? 1 : 0,
        session.retryOfSessionId || null,
        session.createdAt,
        session.updatedAt,
        session.workspace || null,
        session.workbenchProvenance ? JSON.stringify(session.workbenchProvenance) : null,
        session.status || 'idle',
        session.lastTokenUsage ? JSON.stringify(session.lastTokenUsage) : null,
        session.gitBranch || null,
        session.projectId ?? null,
      );
    })();
    session.title = title;
  }
