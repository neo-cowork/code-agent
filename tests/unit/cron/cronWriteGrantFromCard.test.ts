// ============================================================================
// 审批卡一键授权（N-FIX-CRON-LOCAL-WRITE-EACH-FILE-APPROVAL-GRANT-ON-CARD）
// 走生产入口：真实 OrchestratorPermissionIsland（停车 → 授权动作 → 放行 → 后续写不再停车）
// + 真实 cronWriteGrant 文件系统守卫；mock 只有 sessionManager / cronService 单例（取活跃 job）。
// HOME / CODE_AGENT_DATA_DIR 指向临时目录，守卫里的「家目录 / 数据目录 / .ssh」都是真实路径判定。
// ============================================================================
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sessions: {} as Record<string, unknown>,
  job: undefined as { metadata?: Record<string, unknown> } | undefined,
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: async (id: string) => state.sessions[id] ?? null }),
}));
vi.mock('../../../src/host/cron/cronService', () => ({
  getCronService: () => ({ getJob: () => state.job ?? null }),
}));
vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyTaskComplete: vi.fn(), notifyNeedsInput: vi.fn() },
}));

import { grantWriteFolderFromParkedApproval, parkedSiblingsCoveredByGrant } from '../../../src/host/cron/cronWriteGrant';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { PermissionRequestReason } from '../../../src/shared/contract/permission';
import type { AppSettings, PermissionAskResult } from '../../../src/shared/contract';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import type { CronJobDefinition } from '../../../src/shared/contract/cron';

const SESSION = 'cron-unbound';
const JOB_ID = 'job-unbound';
let home: string;
let notesDir: string;
const saved = { HOME: process.env.HOME, DATA: process.env.CODE_AGENT_DATA_DIR };

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'neo-card-grant-')));
  notesDir = path.join(home, 'Documents', 'morning-notes');
  mkdirSync(notesDir, { recursive: true });
  mkdirSync(path.join(home, '.ssh'), { recursive: true });
  mkdirSync(path.join(home, '.code-agent'), { recursive: true });
  process.env.HOME = home;
  process.env.CODE_AGENT_DATA_DIR = path.join(home, '.code-agent');
  state.job = { metadata: {} };
  state.sessions = {
    [SESSION]: { id: SESSION, origin: { kind: 'cron', id: JOB_ID, metadata: {} } },
  };
  getPermissionModeManager().markUnattendedSession(SESSION);
});

afterEach(() => {
  resetPermissionModeManager();
  if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
  if (saved.DATA === undefined) delete process.env.CODE_AGENT_DATA_DIR; else process.env.CODE_AGENT_DATA_DIR = saved.DATA;
  rmSync(home, { recursive: true, force: true });
});

function makeRepo() {
  const rows = new Map<string, { kind: string; status: string; payloadJson: string }>();
  const repo = {
    insert: vi.fn((r: { id: string; kind: string; payload: unknown }) => {
      rows.set(r.id, { kind: r.kind, status: 'pending', payloadJson: JSON.stringify(r.payload) });
    }),
    resolve: vi.fn(() => 1),
  } as unknown as PendingApprovalRepository & { insert: ReturnType<typeof vi.fn> };
  return { repo, rows };
}

function makeIsland(repo: PendingApprovalRepository) {
  return new OrchestratorPermissionIsland({
    getSettings: () => ({
      permissions: { autoApprove: { read: false, write: false, execute: false, network: false }, blockedCommands: [], devModeAutoApprove: false },
    } as unknown as AppSettings),
    isDevModeAutoApproveEnabled: () => false,
    getExecutionTopology: () => 'async_agent',
    hasApprovalUi: () => false,
    onEvent: vi.fn(),
    injectedPendingApprovalRepo: repo,
  });
}

// W3 outside_project：无绑定文件夹的 cron 任务对绝对路径写的真实形态。
const w3Write = (target: string) => ({
  type: 'file_write',
  tool: 'Write',
  forceConfirm: true,
  forceConfirmBoundaryOnly: true,
  reasonCode: PermissionRequestReason.FileWriteOutsideWorkspace,
  details: { path: target },
  sessionId: SESSION,
});

const flush = () => new Promise<void>((resolve) => { setImmediate(resolve); });
async function stillPending(p: Promise<PermissionAskResult>): Promise<boolean> {
  const marker = Symbol('pending');
  return (await Promise.race([p, Promise.resolve(marker)])) === marker;
}

function lastParkedPayload(rows: Map<string, { payloadJson: string }>) {
  const [id, row] = [...rows.entries()].at(-1)!;
  return { id, payload: JSON.parse(row.payloadJson) as { writeGrantFolder?: string } };
}

function makeHost() {
  const persisted: CronJobDefinition[] = [];
  const active = { definition: { id: JOB_ID, metadata: state.job?.metadata } as unknown as CronJobDefinition };
  return {
    persisted,
    active,
    host: {
      loadActiveJob: (id: string) => (id === JOB_ID ? active : undefined),
      persistJob: async (job: CronJobDefinition) => {
        persisted.push(job);
        state.job = { metadata: job.metadata };
      },
    },
  };
}

describe('审批卡一键授权：无绑定文件夹任务写 3 个文件只停 1 次', () => {
  it('第 1 个文件停车并带 writeGrantFolder；授权后放行本次，第 2/3 个文件不再停车', async () => {
    const { repo, rows } = makeRepo();
    const island = makeIsland(repo);
    const first = island.requestPermission(w3Write(path.join(notesDir, 'today-plan.md')));
    await flush();
    expect(await stillPending(first)).toBe(true);
    const { id, payload } = lastParkedPayload(rows);
    expect(payload.writeGrantFolder).toBe(notesDir);

    const { host, persisted } = makeHost();
    const grant = await grantWriteFolderFromParkedApproval(id, { getParkedRow: (rid) => rows.get(rid) ?? null, host });
    expect(grant).toMatchObject({ status: 'granted', folder: notesDir, jobId: JOB_ID });
    expect(persisted[0].metadata?.writeGrantRoot).toBe(notesDir);

    expect(island.handlePermissionResponse(id, 'allow')).toBe('delivered');
    await expect(first).resolves.toMatchObject({ approved: true });

    for (const name of ['reading-list.md', 'follow-ups.md']) {
      await expect(island.requestPermission(w3Write(path.join(notesDir, name))))
        .resolves.toEqual({ approved: true, approvalSource: 'schedule-write-grant' });
    }
    expect(repo.insert).toHaveBeenCalledTimes(1);
  });

  it('模型一次并行发 3 个 Write（3 条停车行同时在）：授权后同文件夹的兄弟请求一并放行，范围外的不动', async () => {
    const { repo, rows } = makeRepo();
    const island = makeIsland(repo);
    // 请求先后发出、都不等应答（授权前 4 条同时挂着）；逐条排空是因为 vitest 下并发首次动态导入
    // mock 模块会互相卡住（真 webServer 下三条真并行停车，见证据档真跑一节）。
    const promises: Array<Promise<PermissionAskResult>> = [];
    for (const target of [
      ...['today-plan.md', 'reading-list.md', 'follow-ups.md'].map((n) => path.join(notesDir, n)),
      path.join(home, 'Documents', 'elsewhere.md'),
    ]) {
      promises.push(island.requestPermission(w3Write(target)));
      for (let i = 0; i < 3; i += 1) await flush();
    }
    const parked = promises.slice(0, 3);
    const other = promises[3];
    expect(repo.insert).toHaveBeenCalledTimes(4);
    const [firstId] = [...rows.keys()];
    const { host } = makeHost();
    const grant = await grantWriteFolderFromParkedApproval(firstId, { getParkedRow: (rid) => rows.get(rid) ?? null, host });
    expect(grant.status).toBe('granted');
    const siblings = parkedSiblingsCoveredByGrant(
      [...rows.entries()].map(([id, r]) => ({ id, payloadJson: r.payloadJson })), SESSION, notesDir, firstId,
    );
    expect(siblings).toHaveLength(2);
    for (const id of [firstId, ...siblings]) island.handlePermissionResponse(id, 'allow');
    await expect(Promise.all(parked)).resolves.toEqual([
      expect.objectContaining({ approved: true }), expect.objectContaining({ approved: true }), expect.objectContaining({ approved: true }),
    ]);
    expect(await stillPending(other)).toBe(true);
    island.drainPendingPermissions();
  });

  it('不点按钮：逐文件审批照旧（3 个文件停 3 次）', async () => {
    const { repo } = makeRepo();
    const island = makeIsland(repo);
    for (const name of ['a.md', 'b.md', 'c.md']) {
      const p = island.requestPermission(w3Write(path.join(notesDir, name)));
      await flush();
      expect(await stillPending(p)).toBe(true);
    }
    expect(repo.insert).toHaveBeenCalledTimes(3);
    island.drainPendingPermissions();
  });
});

describe('守卫：这些目标不出按钮（载荷无 writeGrantFolder，仍照旧停车）', () => {
  async function parkedPayloadFor(target: string) {
    const { repo, rows } = makeRepo();
    const island = makeIsland(repo);
    const p = island.requestPermission(w3Write(target));
    await flush();
    expect(await stillPending(p)).toBe(true);
    island.drainPendingPermissions();
    return lastParkedPayload(rows).payload;
  }

  it.each([
    ['$HOME 本身', () => path.join(home, 'direct.md')],
    ['文件系统根', () => '/direct.md'],
    ['Neo 数据目录', () => path.join(home, '.code-agent', 'x.md')],
    ['.ssh（保护路径所在目录）', () => path.join(home, '.ssh', 'x.md')],
    ['保护文件名（家目录下 .env）', () => path.join(notesDir, '.env')],
  ])('%s', async (_name, target) => {
    expect((await parkedPayloadFor(target())).writeGrantFolder).toBeUndefined();
  });

  it('软链逃逸：指向 .ssh 的软链目录 → realpath 后落在保护目录，不出按钮', async () => {
    symlinkSync(path.join(home, '.ssh'), path.join(notesDir, 'link'));
    expect((await parkedPayloadFor(path.join(notesDir, 'link', 'x.md'))).writeGrantFolder).toBeUndefined();
  });

  it('绑定了文件夹（origin 已带授权）的任务不出按钮', async () => {
    state.sessions[SESSION] = { id: SESSION, origin: { kind: 'cron', id: JOB_ID, metadata: { writeGrantRoot: path.join(home, 'Documents') } } };
    expect((await parkedPayloadFor(path.join(home, 'elsewhere.md'))).writeGrantFolder).toBeUndefined();
  });
});

describe('授权动作 host 侧重校验（不信任载荷/renderer）', () => {
  async function parkOne() {
    const { repo, rows } = makeRepo();
    const island = makeIsland(repo);
    const p = island.requestPermission(w3Write(path.join(notesDir, 'today-plan.md')));
    await flush();
    void p;
    return { island, ...lastParkedPayload(rows), rows };
  }

  it('被篡改的 writeGrantFolder（改成家目录）→ folder_mismatch，不落库', async () => {
    const { island, id, rows } = await parkOne();
    const row = rows.get(id)!;
    row.payloadJson = JSON.stringify({ ...JSON.parse(row.payloadJson), writeGrantFolder: home });
    const { host, persisted } = makeHost();
    await expect(grantWriteFolderFromParkedApproval(id, { getParkedRow: (rid) => rows.get(rid) ?? null, host }))
      .resolves.toEqual({ status: 'rejected', reason: 'folder_mismatch' });
    expect(persisted).toHaveLength(0);
    island.drainPendingPermissions();
  });

  it('请求已不是 pending → not_pending；找不到 → not_found', async () => {
    const { island, id, rows } = await parkOne();
    rows.get(id)!.status = 'approved';
    const { host, persisted } = makeHost();
    const deps = { getParkedRow: (rid: string) => rows.get(rid) ?? null, host };
    await expect(grantWriteFolderFromParkedApproval(id, deps)).resolves.toEqual({ status: 'rejected', reason: 'not_pending' });
    await expect(grantWriteFolderFromParkedApproval('nope', deps)).resolves.toEqual({ status: 'rejected', reason: 'not_found' });
    expect(persisted).toHaveLength(0);
    island.drainPendingPermissions();
  });

  it('任务已有不同授权根：不覆盖，返回 kept_existing', async () => {
    const { island, id, rows } = await parkOne();
    const other = path.join(home, 'Documents');
    const { host, persisted, active } = makeHost();
    active.definition = { ...active.definition, metadata: { writeGrantRoot: other } } as CronJobDefinition;
    await expect(grantWriteFolderFromParkedApproval(id, { getParkedRow: (rid) => rows.get(rid) ?? null, host }))
      .resolves.toMatchObject({ status: 'kept_existing', existingRoot: other });
    expect(persisted).toHaveLength(0);
    island.drainPendingPermissions();
  });
});
