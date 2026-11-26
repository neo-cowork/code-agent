// FB-1307：旧 Source 目录已丢失/换身份后，编辑项目里「换成一个有效目录」必须一次保存成功。
// 真实 ProjectService + 真 folderTrust + 真临时目录 + 真 git；repo 用内存 fake（同 folderTrust 测试手法）。
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');

import { ProjectService } from '../../../src/host/services/project/projectService';
import { ProjectSourceTrustError } from '../../../src/host/services/project/projectSourceTrustError';
import {
  closeFolderTrustService,
  resetFolderTrustServiceForTest,
  setFolderTrust,
} from '../../../src/host/security/folderTrustService';
import { configureFolderTrustService } from '../../../src/host/security/folderTrustServiceConfig';
import type { Project, ProjectSource } from '../../../src/shared/contract/project';
import type { ProjectRepository } from '../../../src/host/services/core/repositories';

const NOW = 1_700_000_000_000;

function createRepoFixture() {
  const projects = new Map<string, Project>();
  const sources: ProjectSource[] = [];
  const state = { running: false };
  const repo = {
    getProjectByWorkspaceKey: (key: string) =>
      Array.from(projects.values()).find((project) => project.workspaceKey === key),
    getProject: (id: string) => projects.get(id),
    upsertProject: (project: Project) => { projects.set(project.id, project); },
    upsertSource: (source: ProjectSource) => { sources.push(source); },
    listSources: (projectId: string) => sources.filter((source) => source.projectId === projectId),
    listGoals: () => [],
    listRoles: () => [],
    listSessionIds: () => [],
    hasRunningSessions: () => state.running,
    replaceProjectSources: (project: Project, nextSources: readonly ProjectSource[], expectedRevision: number) => {
      const current = projects.get(project.id);
      if (!current) throw new Error('Project not found.');
      if ((current.sourceRevision ?? 0) !== expectedRevision) {
        throw new Error(`Project Sources changed; expected revision ${expectedRevision}.`);
      }
      for (let index = sources.length - 1; index >= 0; index -= 1) {
        if (sources[index].projectId === project.id) sources.splice(index, 1);
      }
      for (const source of nextSources) sources.push(source);
      const updated: Project = { ...project, sourceRevision: (current.sourceRevision ?? 0) + 1 };
      projects.set(project.id, updated);
      return updated;
    },
  };
  return { projects, sources, state, repo: repo as unknown as ProjectRepository };
}

describe('ProjectService.updateProject: swapping out an unhealthy old Source', () => {
  let tmpRoot: string;
  let oldDir: string;
  let newDir: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'project-source-swap-'));
    oldDir = path.join(tmpRoot, 'old');
    newDir = path.join(tmpRoot, 'new');
    await fs.mkdir(newDir, { recursive: true });
    vi.stubEnv('CODE_AGENT_DATA_DIR', path.join(tmpRoot, 'data'));
    closeFolderTrustService();
    configureFolderTrustService({});
    await setFolderTrust(newDir, 'trusted', 'test');
  });

  afterEach(async () => {
    resetFolderTrustServiceForTest();
    vi.unstubAllEnvs();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function createProjectOn(dir: string, allowMissingDir = false) {
    const fixture = createRepoFixture();
    const service = new ProjectService(() => fixture.repo);
    const project = await service.ensureProjectForWorkspace(dir, NOW, { allowMissingDir });
    const [oldSource] = fixture.sources;
    const swap = (extra: Record<string, unknown> = {}) => service.updateProject({
      projectId: project.id,
      revision: project.sourceRevision ?? 0,
      name: 'swapped',
      sources: [{ path: newDir, role: 'primary', access: 'read_write' }],
      ...extra,
    }, NOW + 1);
    return { ...fixture, service, project, oldSource, swap };
  }

  it('old Source dir never existed → swap to a trusted existing dir succeeds in one call', async () => {
    const f = await createProjectOn(oldDir, true);
    expect(() => f.service.getWorkspaceScope(f.project.id)).toThrow(ProjectSourceTrustError);

    const updated = await f.swap();

    expect(updated?.sources.map((source) => source.path)).toEqual([newDir]);
    expect(f.sources.map((source) => source.id)).not.toContain(f.oldSource.id);
    expect(f.service.getWorkspaceScope(f.project.id)?.primaryRoot).toBe(await fs.realpath(newDir));
  });

  it('getWorkspaceScope stays fail-closed with source_missing while the missing Source is kept', async () => {
    const f = await createProjectOn(oldDir, true);
    expect(() => f.service.getWorkspaceScope(f.project.id)).toThrowError(
      expect.objectContaining({ code: 'PROJECT_SOURCE_TRUST', kind: 'source_missing' }),
    );
  });

  it('old Source identity changed (dir deleted and recreated) → swap succeeds', async () => {
    await fs.mkdir(oldDir);
    const f = await createProjectOn(oldDir);
    f.oldSource.identityBirthtimeNs = '1';
    f.oldSource.identityIno = '1';
    expect(() => f.service.getWorkspaceScope(f.project.id)).toThrowError(
      expect.objectContaining({ kind: 'identity_changed' }),
    );

    await expect(f.swap()).resolves.toBeDefined();
    expect(f.sources.map((source) => source.path)).toEqual([newDir]);
  });

  describe('healthy old Source with uncommitted changes', () => {
    async function dirtyProject() {
      await fs.mkdir(oldDir);
      execFileSync('git', ['init', '-q'], { cwd: oldDir });
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: oldDir });
      await fs.writeFile(path.join(oldDir, 'base.txt'), 'base');
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      await fs.writeFile(path.join(oldDir, 'wip.txt'), 'unsaved work');
      return createProjectOn(oldDir);
    }

    it('without confirmation → still refused, Sources untouched', async () => {
      const f = await dirtyProject();
      await expect(f.swap()).rejects.toMatchObject({ code: 'PROJECT_UPDATE_DIRTY_SOURCE' });
      expect(f.sources.map((source) => source.id)).toEqual([f.oldSource.id]);
      expect(f.projects.get(f.project.id)?.sourceRevision ?? 0).toBe(0);
    });

    it('with confirmation → succeeds', async () => {
      const f = await dirtyProject();
      await expect(f.swap({ confirmedDirtySourceIds: [f.oldSource.id] })).resolves.toBeDefined();
      expect(f.sources.map((source) => source.path)).toEqual([newDir]);
    });
  });

  it('running task → still refused with a stable code, even when the old Source is missing', async () => {
    const f = await createProjectOn(oldDir, true);
    f.state.running = true;
    await expect(f.swap()).rejects.toMatchObject({ code: 'PROJECT_UPDATE_RUNNING_TASK' });
    expect(f.sources.map((source) => source.id)).toEqual([f.oldSource.id]);
  });

  it('save is all-or-nothing: a failing check leaves every Source row and the revision unchanged', async () => {
    const f = await createProjectOn(oldDir, true);
    const untrusted = path.join(tmpRoot, 'untrusted');
    await fs.mkdir(path.join(untrusted, '.code-agent', 'hooks'), { recursive: true });
    await fs.writeFile(path.join(untrusted, '.code-agent', 'hooks', 'hooks.json'), '{"PreToolUse":[]}');
    const before = JSON.stringify(f.sources);

    await expect(f.service.updateProject({
      projectId: f.project.id,
      revision: 0,
      name: 'x',
      sources: [{ path: untrusted, role: 'primary', access: 'read_write' }],
    }, NOW + 1)).rejects.toMatchObject({ code: 'PROJECT_UPDATE_FOLDER_TRUST' });

    expect(JSON.stringify(f.sources)).toBe(before);
    expect(f.projects.get(f.project.id)?.sourceRevision ?? 0).toBe(0);
  });

  it('stale revision → PROJECT_UPDATE_REVISION_CONFLICT and Sources unchanged', async () => {
    const f = await createProjectOn(oldDir, true);
    await expect(f.swap({ revision: 5 })).rejects.toMatchObject({ code: 'PROJECT_UPDATE_REVISION_CONFLICT' });
    expect(f.sources.map((source) => source.id)).toEqual([f.oldSource.id]);
  });

  it('duplicate path and read-only-unusable Primary carry stable codes', async () => {
    const f = await createProjectOn(oldDir, true);
    await expect(f.service.updateProject({
      projectId: f.project.id, revision: 0, name: 'x',
      sources: [
        { path: newDir, role: 'primary', access: 'read_write' },
        { path: newDir, role: 'additional', access: 'read_only' },
      ],
    }, NOW + 1)).rejects.toMatchObject({ code: 'PROJECT_UPDATE_DUPLICATE_PATH' });

    await fs.chmod(newDir, 0o555);
    try {
      if (process.getuid?.() !== 0) {
        await expect(f.swap()).rejects.toMatchObject({ code: 'PROJECT_UPDATE_PRIMARY_UNWRITABLE' });
      }
    } finally {
      await fs.chmod(newDir, 0o755);
    }
  });
});
