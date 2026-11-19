// listProjectsWithActivity 的 sessionCount 是全量统计（不受侧栏分页影响），侧栏据此判定空空间。
import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { ProjectRepository } from '../../../src/host/services/core/repositories/ProjectRepository';
import { createLogger } from '../../../src/host/services/infra/logger';

describe('ProjectRepository.listProjectsWithActivity sessionCount', () => {
  it('counts live sessions per space; a never-used space is 0', () => {
    const db = new Database(':memory:');
    const logger = createLogger('spaceSessionCount.test');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    const repo = new ProjectRepository(db);
    const mk = (id: string) => {
      repo.upsertProject({ id, name: id, workspacePath: null, workspaceKey: null, status: 'active', createdAt: 1, updatedAt: 1, archivedAt: null, spacePromotedAt: 1 } as never);
    };
    mk('proj_used'); mk('proj_empty');
    for (const n of [1, 2]) {
      db.prepare("INSERT INTO sessions (id, title, model_provider, model_name, project_id, created_at, updated_at) VALUES (?, 't', 'p', 'm', 'proj_used', 1, 1)").run(`s${n}`);
    }
    const byId = Object.fromEntries(repo.listProjectsWithActivity(false, true).map((p) => [p.id, p.sessionCount]));
    expect(byId).toMatchObject({ proj_used: 2, proj_empty: 0 });
    db.close();
  });
});
