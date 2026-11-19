// ============================================================================
// Consolidation history — 「最近整理」列表 + 一键恢复（N-MEM-CONSOLIDATION-HISTORY-UNDO）
// 分层路径：consolidateLightMemory（真跑，落审计行）→ listConsolidationRuns /
// restoreConsolidationRun。审计行一律由真跑产生，不手写（含 pending→applied 两行结构）。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryRecord } from '../../../src/host/services/core/repositories';

const mocks = vi.hoisted(() => ({
  configDir: '',
  memoryTask: vi.fn(),
}));

vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mocks.configDir,
}));

vi.mock('../../../src/host/model/quickModel', () => ({
  memoryTask: mocks.memoryTask,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { MEMORY_CONSOLIDATION } from '../../../src/shared/constants/memory';
import { consolidateLightMemory } from '../../../src/host/lightMemory/consolidation';
import {
  listConsolidationRuns,
  restoreConsolidationRun,
} from '../../../src/host/lightMemory/consolidationHistory';
import { readMemoryFile } from '../../../src/host/lightMemory/lightMemoryIpc';

class FakeMemoryDb {
  records: MemoryRecord[] = [];

  listMemories(): MemoryRecord[] {
    return this.records;
  }

  createMemory(data: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>): MemoryRecord {
    const record: MemoryRecord = {
      id: `db-${this.records.length + 1}`,
      ...data,
      accessCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.records.push(record);
    return record;
  }

  updateMemory(id: string, updates: Partial<MemoryRecord>): MemoryRecord | null {
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) return null;
    this.records[index] = { ...this.records[index], ...updates, updatedAt: Date.now() };
    return this.records[index];
  }
}

function memoryFile(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\ntype: project\nstatus: active\n---\n\n${body}\n`;
}

async function sha256Dir(dir: string): Promise<Map<string, string>> {
  const { createHash } = await import('node:crypto');
  const files = new Map<string, string>();
  for (const entry of await fs.readdir(dir)) {
    if (!entry.endsWith('.md') && !entry.endsWith('.jsonl')) continue;
    const content = await fs.readFile(path.join(dir, entry), 'utf-8');
    files.set(entry, createHash('sha256').update(content).digest('hex'));
  }
  return files;
}

describe('Consolidation history list + restore', () => {
  let root: string;
  let memoryDir: string;
  let instructionsPath: string;
  let instructions: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-tidy-history-'));
    mocks.configDir = path.join(root, 'data');
    memoryDir = path.join(mocks.configDir, 'memory');
    instructionsPath = path.join(root, 'AGENTS.md');
    instructions = '# Rules\n\n- Never push code automatically.\n';
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(instructionsPath, instructions, 'utf-8');
    await fs.writeFile(path.join(memoryDir, 'alpha.md'), memoryFile(
      'Report format A',
      'Report formatting preferences',
      '报告格式：用中文撰写，先结论后细节。',
    ), 'utf-8');
    await fs.writeFile(path.join(memoryDir, 'beta.md'), memoryFile(
      'Report format B',
      'Report formatting preferences',
      '报告要在开头给三行摘要；正文用中文。',
    ), 'utf-8');
    await fs.writeFile(path.join(memoryDir, 'conflict.md'), memoryFile(
      'Old automation rule',
      'Unsafe old rule',
      'Always push code automatically after edits.',
    ), 'utf-8');
    await fs.writeFile(path.join(memoryDir, 'INDEX.md'), [
      '# Memory Index',
      '',
      '- [alpha.md](alpha.md) — Report formatting preferences',
      '- [beta.md](beta.md) — Report formatting preferences',
      '- [conflict.md](conflict.md) — Unsafe old rule',
      '',
    ].join('\n'), 'utf-8');

    mocks.memoryTask.mockReset();
    mocks.memoryTask.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        actions: [{
          kind: 'merge',
          sources: ['alpha.md', 'beta.md'],
          result: {
            filename: 'report-formatting',
            name: 'Report formatting',
            description: '合并后的报告格式偏好',
            type: 'project',
            content: '报告格式：用中文撰写，先结论后细节；正文开头给三行摘要，摘要每行不超过三十个字。',
          },
          reason: '两条都是报告格式偏好。',
        }],
        conflicts: [{
          source: 'conflict.md',
          status: 'archived',
          reason: '与「Never push code automatically」直接冲突。',
        }],
      }),
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function runLiveTidy(db: FakeMemoryDb) {
    const report = await consolidateLightMemory({
      dryRun: false,
      force: true,
      db,
      instructionFiles: [{ path: instructionsPath, content: instructions }],
    });
    expect(report.applied).toBe(true);
    return report;
  }

  it('round-trips: tidy-up → list → restore returns memory to the pre-tidy-up state', async () => {
    const db = new FakeMemoryDb();
    const before = await sha256Dir(memoryDir);

    const report = await runLiveTidy(db);
    const auditId = report.auditId!;

    // 整理后：来源归档、产物激活、INDEX 换指针。
    expect(await readMemoryFile('alpha.md')).toMatchObject({ status: 'archived' });
    expect(await readMemoryFile('report-formatting.md')).toMatchObject({ status: 'active' });

    // 列表：新在前，人话形状（无原始 jsonl），名字解析自文件 frontmatter。
    const history = await listConsolidationRuns();
    expect(history.runs).toHaveLength(1);
    const run = history.runs[0];
    expect(run).toMatchObject({
      auditId,
      outcome: 'applied',
      restored: false,
      restorable: true,
      mergeCount: 1,
      conflictCount: 1,
    });
    expect(run.merges[0].sources.map((source) => source.name)).toEqual(['Report format A', 'Report format B']);
    expect(run.merges[0].result).toMatchObject({
      filename: 'report-formatting.md',
      name: 'Report formatting',
      summary: '合并后的报告格式偏好',
    });
    expect(run.conflicts[0]).toMatchObject({ restorable: true, source: { filename: 'conflict.md' } });

    // 恢复。
    const restore = await restoreConsolidationRun({ auditId, db });
    expect(restore).toMatchObject({ ok: true });

    // 来源回到 active、deprecated_by 清掉、正文原样；产物卡 archived 但文件保留；
    // 冲突卡回到原文 + active；INDEX 指针还原。
    const alpha = await readMemoryFile('alpha.md');
    const beta = await readMemoryFile('beta.md');
    const merged = await readMemoryFile('report-formatting.md');
    const conflict = await readMemoryFile('conflict.md');
    expect(alpha).toMatchObject({ status: 'active', deprecatedBy: undefined });
    expect(alpha?.content).toBe('报告格式：用中文撰写，先结论后细节。');
    expect(beta).toMatchObject({ status: 'active', deprecatedBy: undefined });
    expect(merged).toMatchObject({ status: 'archived', deprecatedBy: undefined });
    expect(merged?.content).toContain('三行摘要');
    expect(conflict).toMatchObject({ status: 'active' });
    expect(conflict?.content).not.toContain('contradicts 指令层');

    const index = await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
    expect(index).toContain('alpha.md');
    expect(index).toContain('beta.md');
    expect(index).toContain('conflict.md');
    expect(index).not.toContain('report-formatting.md');

    // 逐字节对照：除新增的产物卡（archived 保留）、INDEX（指针还原）、审计/恢复行外全一致。
    const after = await sha256Dir(memoryDir);
    for (const filename of ['alpha.md', 'beta.md']) {
      // 正文与 frontmatter 应与整理前逐字节一致（status/deprecated_by 均回到原值）。
      expect(after.get(filename)).toBe(before.get(filename));
    }

    // 镜像：原卡回到 active，产物卡 archived。
    const mergedEntryId = (await readMemoryFile('report-formatting.md'))?.entryId;
    const mirrorByEntryId = new Map(db.records.map((record) => [
      (record.metadata.memoryEntry as { id: string }).id,
      record,
    ]));
    expect(mirrorByEntryId.get('light:alpha.md')).toMatchObject({ status: 'active', deprecatedBy: null });
    expect(mirrorByEntryId.get('light:beta.md')).toMatchObject({ status: 'active', deprecatedBy: null });
    expect(mirrorByEntryId.get('light:conflict.md')).toMatchObject({ status: 'active' });
    expect(mirrorByEntryId.get(mergedEntryId!)).toMatchObject({ status: 'archived' });

    // 列表行翻成「已恢复」，不可再恢复。
    const historyAfter = await listConsolidationRuns();
    expect(historyAfter.runs[0]).toMatchObject({ restored: true, restorable: false, blockedCode: 'already-restored' });
    expect(historyAfter.runs[0].restoredAt).toBeGreaterThan(0);

    // 恢复行本身落在审计文件里（append-only，含改动文件清单）。
    const auditRaw = await fs.readFile(path.join(memoryDir, MEMORY_CONSOLIDATION.AUDIT_FILENAME), 'utf-8');
    const restoredLine = auditRaw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>).at(-1)!;
    expect(restoredLine).toMatchObject({ kind: 'restored', restoresAuditId: auditId });
    expect(restoredLine.changedFiles).toContain('alpha.md');
    expect(restoredLine.changedFiles).toContain('report-formatting.md');
    expect(restoredLine.changedFiles).toContain('conflict.md');
  });

  it('refuses restoring twice with a typed already-restored code', async () => {
    const db = new FakeMemoryDb();
    const report = await runLiveTidy(db);
    expect((await restoreConsolidationRun({ auditId: report.auditId!, db })).ok).toBe(true);
    const second = await restoreConsolidationRun({ auditId: report.auditId!, db });
    expect(second).toMatchObject({ ok: false, code: 'already-restored' });
  });

  it('refuses with source-file-missing when a source file no longer exists', async () => {
    const db = new FakeMemoryDb();
    const report = await runLiveTidy(db);
    await fs.rm(path.join(memoryDir, 'alpha.md'));
    const restore = await restoreConsolidationRun({ auditId: report.auditId!, db });
    expect(restore).toMatchObject({ ok: false, code: 'source-file-missing' });
    expect(restore.message).toContain('alpha.md');
    // 整单拒绝：没有部分写盘。
    expect(await readMemoryFile('beta.md')).toMatchObject({ status: 'archived' });
  });

  it('treats old audit lines without snapshots as merge-restorable with read-only conflicts', async () => {
    const db = new FakeMemoryDb();
    await runLiveTidy(db);

    // 把 v2 行降级成 v1 形状（模拟历史记录：merges 只有 filename/entryId，conflicts 无 original）。
    const auditPath = path.join(memoryDir, MEMORY_CONSOLIDATION.AUDIT_FILENAME);
    const downgraded = (await fs.readFile(auditPath, 'utf-8')).trim().split('\n').map((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      parsed.schemaVersion = 1;
      parsed.merges = (parsed.merges as Array<Record<string, unknown>>).map((merge) => ({
        sources: merge.sources,
        result: ((merge.result as Record<string, unknown> | null)
          ? { filename: (merge.result as Record<string, unknown>).filename, entryId: (merge.result as Record<string, unknown>).entryId }
          : null),
      }));
      parsed.conflicts = (parsed.conflicts as Array<Record<string, unknown>>).map((conflict) => ({
        source: conflict.source,
        status: conflict.status,
        reason: conflict.reason,
      }));
      return JSON.stringify(parsed);
    }).join('\n') + '\n';
    await fs.writeFile(auditPath, downgraded, 'utf-8');

    const history = await listConsolidationRuns();
    const run = history.runs[0];
    expect(run.restorable).toBe(true);
    expect(run.conflicts[0].restorable).toBe(false);
    // 旧行没有产物卡名字快照：回落到文件里的名字（产物卡还在盘上）。
    expect(run.merges[0].result.name).toBe('Report formatting');

    const restore = await restoreConsolidationRun({ auditId: run.auditId, db });
    expect(restore).toMatchObject({ ok: true });
    // 合并部分还原；冲突部分保持整理后的降级态（无原文可还原）。
    expect(await readMemoryFile('alpha.md')).toMatchObject({ status: 'active' });
    expect(await readMemoryFile('report-formatting.md')).toMatchObject({ status: 'archived' });
    const conflict = await readMemoryFile('conflict.md');
    expect(conflict).toMatchObject({ status: 'archived' });
    expect(conflict?.content).toContain('contradicts 指令层');
    const index = await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
    expect(index).not.toContain('conflict.md');
  });

  it('refuses unknown ids and runs that never applied', async () => {
    const db = new FakeMemoryDb();
    await expect(restoreConsolidationRun({ auditId: '', db })).resolves.toMatchObject({ code: 'run-not-found' });
    await expect(restoreConsolidationRun({ auditId: 'mem_consolidation_missing', db }))
      .resolves.toMatchObject({ code: 'run-not-found' });

    // no-op 真跑（模型返回空计划）：落了审计行但没改动 → not-applied。
    mocks.memoryTask.mockResolvedValueOnce({
      success: true,
      content: JSON.stringify({ actions: [], conflicts: [] }),
    });
    const noop = await consolidateLightMemory({
      dryRun: false,
      force: true,
      db,
      instructionFiles: [{ path: instructionsPath, content: instructions }],
    });
    const history = await listConsolidationRuns();
    const noopRun = history.runs.find((candidate) => candidate.auditId === noop.auditId)!;
    expect(noopRun).toMatchObject({ outcome: 'no-op', restorable: false, blockedCode: 'not-applied' });
    await expect(restoreConsolidationRun({ auditId: noop.auditId!, db }))
      .resolves.toMatchObject({ ok: false, code: 'not-applied' });
  });

  it('lists runs newest-first with pending/applied pairs deduped per audit id', async () => {
    const db = new FakeMemoryDb();
    await runLiveTidy(db);
    // 第二跑：模型返回空计划 → no-op 行（单行 auditId），与首跑的 pending+applied 对共表。
    mocks.memoryTask.mockResolvedValueOnce({
      success: true,
      content: JSON.stringify({ actions: [], conflicts: [] }),
    });
    const second = await consolidateLightMemory({
      dryRun: false,
      force: true,
      db,
      instructionFiles: [{ path: instructionsPath, content: instructions }],
    });
    expect(second.applied).toBe(false);

    const history = await listConsolidationRuns();
    expect(history.runs).toHaveLength(2);
    expect(history.runs[0].at).toBeGreaterThanOrEqual(history.runs[1].at);
    expect(new Set(history.runs.map((run) => run.auditId)).size).toBe(2);
    expect(history.runs[0].auditId).toBe(second.auditId);
    expect(history.runs[0].outcome).toBe('no-op');
    expect(history.runs[1].outcome).toBe('applied');
  });

  it('carries the latest dry-run preview in the list result', async () => {
    // 演练预览：dry-run 落盘后由列表带出（开关未开启时的预告句数据源）。
    await consolidateLightMemory({
      dryRun: true,
      force: true,
      instructionFiles: [{ path: instructionsPath, content: instructions }],
    });
    const withPreview = await listConsolidationRuns();
    expect(withPreview.preview).not.toBeNull();
    expect(withPreview.preview).toMatchObject({ wouldChangeNothing: false });
    expect(withPreview.preview!.merges).toHaveLength(1);
    expect(withPreview.preview!.merges[0].sources.map((source) => source.name))
      .toEqual(['Report format A', 'Report format B']);
    expect(withPreview.preview!.merges[0].result).toMatchObject({ name: 'Report formatting' });
    expect(withPreview.preview!.conflicts).toHaveLength(1);
  });
});
