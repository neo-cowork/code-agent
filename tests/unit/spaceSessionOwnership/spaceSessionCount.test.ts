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

  function seed() {
    const db = new Database(':memory:');
    const logger = createLogger('spaceSessionCount.test');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    const repo = new ProjectRepository(db);
    for (const id of ['proj_arch', 'proj_other', 'proj_visible']) {
      repo.upsertProject({ id, name: id, workspacePath: null, workspaceKey: null, status: 'active', createdAt: 1, updatedAt: 1, archivedAt: null, spacePromotedAt: 1 } as never);
    }
    const add = (id: string, project: string, status: string, userId: string | null) =>
      db.prepare("INSERT INTO sessions (id, title, model_provider, model_name, project_id, status, user_id, created_at, updated_at) VALUES (?, 't', 'p', 'm', ?, ?, ?, 1, 1)").run(id, project, status, userId);
    add('a1', 'proj_arch', 'archived', 'u1');
    add('o1', 'proj_other', 'idle', 'u2');
    add('v1', 'proj_visible', 'idle', 'u1');
    return { db, repo };
  }
  const counts = (repo: ProjectRepository, owner?: string | null) =>
    Object.fromEntries(repo.listProjectsWithActivity(false, true, owner).map((p) => [p.id, p.sessionCount]));

  it('(a) a space whose only session is archived counts 0', () => {
    const { db, repo } = seed();
    expect(counts(repo, 'u1').proj_arch).toBe(0);
    db.close();
  });

  it('(b) another owner\'s session does not count for the current owner; logged-out only counts NULL-owner rows', () => {
    const { db, repo } = seed();
    expect(counts(repo, 'u1').proj_other).toBe(0);
    expect(counts(repo, null)).toMatchObject({ proj_other: 0, proj_visible: 0 }); // non-null owners are invisible when logged out
    db.close();
  });

  it('(c) a visible, non-archived session of the current owner counts 1', () => {
    const { db, repo } = seed();
    expect(counts(repo, 'u1').proj_visible).toBe(1);
    expect(counts(repo, 'u2').proj_other).toBe(1);
    db.close();
  });
});
