import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { hydrateApprovalGatesAtBoot } from '../../../src/host/agent/parkedApprovalHydration';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { SessionAutomationService } from '../../../src/host/services/sessionAutomation/sessionAutomationService';
import type { createLogger } from '../../../src/host/services/infra/logger';
import { PARKED_APPROVAL_VOIDED_RETENTION_MS } from '../../../src/shared/constants/pendingApproval';
import type { PendingApprovalStatus } from '../../../src/shared/contract/pendingApproval';

vi.mock('../../../src/host/agent/planApproval', () => ({
  getPlanApprovalGate: () => ({ attachPersistence: () => 0 }),
}));
vi.mock('../../../src/host/agent/swarmLaunchApproval', () => ({
  getSwarmLaunchApprovalGate: () => ({ attachPersistence: () => 0 }),
}));

let repoRef: PendingApprovalRepository;
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getPendingApprovalRepo: () => repoRef }),
}));

const PREFIX = '重启前发起 · ';
const AUTO_REJECTED = 'Auto-rejected after restart: expired_after_restart_24h';
const NOW = 1_800_000_000_000;

type RawRow = Record<string, unknown>;

function rawRows(db: BetterSqlite3.Database): RawRow[] {
  return db.prepare('SELECT * FROM pending_approvals ORDER BY id').all() as RawRow[];
}

function payloadWithoutDisplayTool(payloadJson: string): unknown {
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;
  delete payload.displayTool;
  return payload;
}

function rowWithoutPayload(row: RawRow): RawRow {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'payload_json'));
}

describe('closed parked approval restart-prefix migration (real file-backed SQLite)', () => {
  let dir: string;
  let db: BetterSqlite3.Database;
  let repo: PendingApprovalRepository;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'parked-prefix-migration-')));
    db = new Database(path.join(dir, 'test.db'));
    db.pragma('foreign_keys = ON');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ReturnType<typeof createLogger>;
    applySchema(db, logger);
    repo = new PendingApprovalRepository(db);
    repoRef = repo;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedClosed(
    id: string,
    status: Exclude<PendingApprovalStatus, 'pending'>,
    displayTool: string,
    submittedAt: number,
  ): void {
    repo.insert({
      id,
      kind: 'tool_approval',
      agentId: 'agent-id',
      agentName: 'agent-name',
      coordinatorId: `session-${id}`,
      payload: {
        sessionId: `session-${id}`,
        tool: 'Bash',
        displayTool,
        requestedAt: submittedAt,
        argsPreview: '汇总本周会议纪要',
        nested: { keep: true },
      },
      submittedAt,
    });
    repo.resolve({ id, status, feedback: AUTO_REJECTED, resolvedAt: submittedAt + 10 });
  }

  it('①②③ 已关闭堆叠行收敛，原始列与其他 payload 字段不变，第二次启动零变更', () => {
    seedClosed('approved-stacked', 'approved', PREFIX.repeat(4) + 'Bash', 1_000);
    seedClosed('plain', 'rejected', 'Bash', 2_000);
    seedClosed('single', 'rejected', PREFIX + 'Bash', 3_000);
    seedClosed('stacked-3', 'rejected', PREFIX.repeat(3) + 'Bash', 4_000);
    db.prepare(
      `INSERT INTO pending_approvals (
        id, kind, agent_id, agent_name, coordinator_id, payload_json, status, submitted_at, resolved_at, feedback
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'invalid-json', 'tool_approval', null, null, null,
      `{"displayTool":"${PREFIX}${PREFIX}Bash"`, 'rejected', 5_000, 5_010, AUTO_REJECTED,
    );
    repo.insert({
      id: 'other-kind',
      kind: 'plan',
      agentId: null,
      agentName: null,
      coordinatorId: null,
      payload: { displayTool: PREFIX.repeat(3) + 'Bash' },
      submittedAt: 6_000,
    });
    const before = rawRows(db);
    const beforeById = new Map(before.map((row) => [row.id, row]));

    hydrateApprovalGatesAtBoot(repo, NOW);

    const after = rawRows(db);
    const afterById = new Map(after.map((row) => [row.id, row]));
    expect(JSON.parse(String(afterById.get('approved-stacked')?.payload_json)).displayTool).toBe(PREFIX + 'Bash');
    expect(JSON.parse(String(afterById.get('stacked-3')?.payload_json)).displayTool).toBe(PREFIX + 'Bash');
    for (const id of ['plain', 'single', 'invalid-json', 'other-kind']) {
      expect(afterById.get(id)).toEqual(beforeById.get(id));
    }
    for (const id of ['approved-stacked', 'stacked-3']) {
      const oldRow = beforeById.get(id)!;
      const newRow = afterById.get(id)!;
      expect(rowWithoutPayload(newRow)).toEqual(rowWithoutPayload(oldRow));
      expect(payloadWithoutDisplayTool(String(newRow.payload_json))).toEqual(
        payloadWithoutDisplayTool(String(oldRow.payload_json)),
      );
    }

    hydrateApprovalGatesAtBoot(repo, NOW + 1_000);
    expect(rawRows(db)).toEqual(after);
    const secondRunChangeCount = db.prepare(
      `SELECT COUNT(*) AS count FROM pending_approvals
         WHERE kind = 'tool_approval' AND status != 'pending'
           AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.displayTool') END LIKE ?`,
    ).get(`${PREFIX}${PREFIX}%`) as { count: number };
    expect(secondRunChangeCount.count).toBe(0);
  });

  it('④ 真实 11 行夹具经生产启动入口与收件箱服务后标题收敛，三天后不再显示', () => {
    for (let index = 0; index < 11; index += 1) {
      const prefixCount = index === 10 ? 26 : index + 2;
      seedClosed(`fixture-${String(index).padStart(2, '0')}`, 'rejected', PREFIX.repeat(prefixCount) + 'Bash', NOW - 20_000 + index);
    }
    expect(Math.max(...rawRows(db).map((row) => String(row.payload_json && JSON.parse(String(row.payload_json)).displayTool).length))).toBe(212);

    hydrateApprovalGatesAtBoot(repo, NOW);
    const inbox = new SessionAutomationService().listParkedApprovals();
    const voided = inbox.filter((item) => item.status === 'voided');
    expect(voided).toHaveLength(11);
    expect(voided.every((item) => !(item.displayTool ?? item.tool).includes(PREFIX + PREFIX))).toBe(true);
    expect(Math.max(...voided.map((item) => (item.displayTool ?? item.tool).length))).toBe(12);

    vi.spyOn(Date, 'now').mockReturnValue(NOW + PARKED_APPROVAL_VOIDED_RETENTION_MS + 1);
    expect(new SessionAutomationService().listParkedApprovals().filter((item) => item.status === 'voided')).toHaveLength(0);
  });
});
