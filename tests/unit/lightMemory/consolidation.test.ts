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

describe('Light Memory consolidation live contract', () => {
  let root: string;
  let memoryDir: string;
  let instructionsPath: string;
  let instructions: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-consolidation-'));
    mocks.configDir = path.join(root, 'data');
    memoryDir = path.join(mocks.configDir, 'memory');
    instructionsPath = path.join(root, 'AGENTS.md');
    instructions = '# Rules\n\n- Never push code automatically.\n';
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(instructionsPath, instructions, 'utf-8');
    await fs.writeFile(path.join(memoryDir, 'alpha.md'), memoryFile(
      'Shared release notes',
      'Release facts',
      'Alpha original fact: release requires tests.',
    ), 'utf-8');
    await fs.writeFile(path.join(memoryDir, 'beta.md'), memoryFile(
      'Shared release notes',
      'Release facts',
      'Beta original fact: release requires approval.',
    ), 'utf-8');
    await fs.writeFile(path.join(memoryDir, 'conflict.md'), memoryFile(
      'Old automation rule',
      'Unsafe old rule',
      'Always push code automatically after edits.',
    ), 'utf-8');
    await fs.writeFile(path.join(memoryDir, 'INDEX.md'), [
      '# Memory Index',
      '',
      'Owner prose must survive consolidation.',
      '',
      '- [alpha.md](alpha.md) — Release facts',
      '- [beta.md](beta.md) — Release facts',
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
            filename: 'release-governance',
            name: 'Release governance',
            description: 'Merged release facts',
            type: 'project',
            content: 'Alpha original fact: release requires tests. Beta original fact: release requires approval.',
          },
          reason: 'The two cards cover the same release topic.',
        }],
        conflicts: [{
          source: 'conflict.md',
          status: 'archived',
          reason: 'AGENTS.md says code must never be pushed automatically.',
        }],
      }),
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('excludes a tainted persisted candidate from prompt and model-selected merges', async () => {
    const alpha = path.join(memoryDir, 'alpha.md');
    await fs.writeFile(alpha, (await fs.readFile(alpha, 'utf8')).replace('status: active', 'status: active\nmemory_tainted: true'));
    const original = await fs.readFile(alpha, 'utf8');
    const report = await consolidateLightMemory({ force: true, workingDirectory: root, db: new FakeMemoryDb() });
    expect(mocks.memoryTask.mock.calls[0][0]).not.toContain('Alpha original fact');
    expect(report.actions).toEqual([]);
    expect(await fs.readFile(alpha, 'utf8')).toBe(original);
    expect(await readMemoryFile('alpha.md')).toMatchObject({ memoryTainted: true, status: 'active' });
  });

  it('keeps dry-run strictly read-only', async () => {
    const beforeIndex = await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
    const beforeAlpha = await fs.readFile(path.join(memoryDir, 'alpha.md'), 'utf-8');

    const report = await consolidateLightMemory({
      dryRun: true,
      force: true,
      instructionFiles: [{ path: instructionsPath, content: instructions }],
    });

    expect(report.dryRun).toBe(true);
    expect(report.applied).toBe(false);
    expect(report.actions).toHaveLength(1);
    expect(report.conflicts).toHaveLength(1);
    expect(mocks.memoryTask.mock.calls[0][0]).toContain('Never push code automatically.');
    expect(await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8')).toBe(beforeIndex);
    expect(await fs.readFile(path.join(memoryDir, 'alpha.md'), 'utf-8')).toBe(beforeAlpha);
    await expect(fs.stat(path.join(memoryDir, 'release-governance.md'))).rejects.toThrow();
    await expect(fs.stat(path.join(memoryDir, MEMORY_CONSOLIDATION.AUDIT_FILENAME))).rejects.toThrow();
    expect(await fs.readFile(instructionsPath, 'utf-8')).toBe(instructions);
  });

  it('creates a new card, soft-archives originals in both ledgers, and audits instruction reconciliation', async () => {
    const db = new FakeMemoryDb();

    const report = await consolidateLightMemory({
      dryRun: false,
      force: true,
      db,
      instructionFiles: [{ path: instructionsPath, content: instructions }],
    });

    expect(report.applied).toBe(true);
    expect(await fs.readFile(instructionsPath, 'utf-8')).toBe(instructions);
    const result = await readMemoryFile('release-governance.md');
    const alpha = await readMemoryFile('alpha.md');
    const beta = await readMemoryFile('beta.md');
    const conflict = await readMemoryFile('conflict.md');
    expect(result?.status).toBe('active');
    expect(result?.entryId).toMatch(/^mem_entry_consolidated_/);
    expect(alpha).toMatchObject({ status: 'archived', deprecatedBy: result?.entryId });
    expect(beta).toMatchObject({ status: 'archived', deprecatedBy: result?.entryId });
    expect(alpha?.content).toContain('Alpha original fact: release requires tests.');
    expect(beta?.content).toContain('Beta original fact: release requires approval.');
    expect(conflict?.status).toBe('archived');
    expect(conflict?.content).toContain('Always push code automatically after edits.');
    expect(conflict?.content).toContain('contradicts 指令层——verify');

    const index = await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
    expect(index).toContain('Owner prose must survive consolidation.');
    expect(index).toContain('release-governance.md');
    expect(index).not.toContain('alpha.md');
    expect(index).not.toContain('beta.md');
    expect(index).not.toContain('conflict.md');

    const byEntryId = new Map(db.records.map((record) => [
      (record.metadata.memoryEntry as { id: string }).id,
      record,
    ]));
    expect(byEntryId.get('light:alpha.md')).toMatchObject({
      status: 'archived',
      deprecatedBy: result?.entryId,
      content: 'Alpha original fact: release requires tests.',
    });
    expect(byEntryId.get('light:beta.md')).toMatchObject({ status: 'archived', deprecatedBy: result?.entryId });
    expect(byEntryId.get('light:conflict.md')).toMatchObject({ status: 'archived' });
    expect(byEntryId.get(result!.entryId!)).toMatchObject({ status: 'active' });

    const auditLines = (await fs.readFile(
      path.join(memoryDir, MEMORY_CONSOLIDATION.AUDIT_FILENAME),
      'utf-8',
    )).trim().split('\n');
    expect(auditLines).toHaveLength(2);
    const pendingAudit = JSON.parse(auditLines[0]) as Record<string, unknown>;
    const audit = JSON.parse(auditLines[1]) as Record<string, unknown>;
    expect(pendingAudit).toMatchObject({ outcome: 'pending', auditId: report.auditId });
    expect(audit).toMatchObject({
      outcome: 'applied',
      auditId: report.auditId,
      instructionLayerUnchanged: true,
    });
    expect(JSON.stringify(audit)).toContain('alpha.md');
    expect(JSON.stringify(audit)).toContain('release-governance.md');
    expect(JSON.stringify(audit)).toContain('conflict.md');
  });

  it('writes a replayable no-op audit row for every live run', async () => {
    mocks.memoryTask.mockResolvedValueOnce({
      success: true,
      content: JSON.stringify({ actions: [], conflicts: [] }),
    });

    const report = await consolidateLightMemory({
      dryRun: false,
      force: true,
      db: new FakeMemoryDb(),
      instructionFiles: [{ path: instructionsPath, content: instructions }],
    });

    expect(report.applied).toBe(false);
    expect(report.auditId).toMatch(/^mem_consolidation_/);
    const audit = JSON.parse((await fs.readFile(
      path.join(memoryDir, MEMORY_CONSOLIDATION.AUDIT_FILENAME),
      'utf-8',
    )).trim()) as Record<string, unknown>;
    expect(audit).toMatchObject({ outcome: 'no-op', merges: [], conflicts: [] });
  });

  it('aborts before changing memory files when the pending audit cannot be written', async () => {
    const beforeIndex = await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
    const beforeAlpha = await fs.readFile(path.join(memoryDir, 'alpha.md'), 'utf-8');
    const beforeBeta = await fs.readFile(path.join(memoryDir, 'beta.md'), 'utf-8');
    await fs.mkdir(path.join(memoryDir, MEMORY_CONSOLIDATION.AUDIT_FILENAME));
    const db = new FakeMemoryDb();

    const report = await consolidateLightMemory({
      dryRun: false,
      force: true,
      db,
      instructionFiles: [{ path: instructionsPath, content: instructions }],
    });

    expect(report.applied).toBe(false);
    expect(report.error).toContain('pending audit append failed');
    expect(await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8')).toBe(beforeIndex);
    expect(await fs.readFile(path.join(memoryDir, 'alpha.md'), 'utf-8')).toBe(beforeAlpha);
    expect(await fs.readFile(path.join(memoryDir, 'beta.md'), 'utf-8')).toBe(beforeBeta);
    await expect(fs.stat(path.join(memoryDir, 'release-governance.md'))).rejects.toThrow();
    expect(db.records).toEqual([]);
  });

  it('skips healthy small stores without calling the model', async () => {
    await fs.rm(path.join(memoryDir, 'beta.md'));
    await fs.rm(path.join(memoryDir, 'conflict.md'));
    await fs.writeFile(path.join(memoryDir, 'INDEX.md'), [
      '# Memory Index',
      '',
      '- [alpha.md](alpha.md) — Release facts',
      '',
    ].join('\n'), 'utf-8');

    const report = await consolidateLightMemory({ dryRun: true });

    expect(report).toMatchObject({ triggered: false, applied: false });
    expect(report.reason).toContain('healthy: 1 files');
    expect(mocks.memoryTask).not.toHaveBeenCalled();
  });

  it('drops model-proposed delete actions without changing their source cards', async () => {
    const beforeAlpha = await fs.readFile(path.join(memoryDir, 'alpha.md'), 'utf-8');
    const beforeIndex = await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
    mocks.memoryTask.mockResolvedValueOnce({
      success: true,
      content: JSON.stringify({
        actions: [{ kind: 'delete', sources: ['alpha.md'], reason: 'model requested deletion' }],
        conflicts: [],
      }),
    });

    const report = await consolidateLightMemory({
      dryRun: true,
      force: true,
      instructionFiles: [{ path: instructionsPath, content: instructions }],
    });

    expect(report.actions).toEqual([]);
    expect(report.applied).toBe(false);
    expect(await fs.readFile(path.join(memoryDir, 'alpha.md'), 'utf-8')).toBe(beforeAlpha);
    expect(await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8')).toBe(beforeIndex);
  });

  it('rejects merge results that try to create directive memory', async () => {
    const beforeAlpha = await fs.readFile(path.join(memoryDir, 'alpha.md'), 'utf-8');
    mocks.memoryTask.mockResolvedValueOnce({
      success: true,
      content: JSON.stringify({
        actions: [{
          kind: 'merge',
          sources: ['alpha.md', 'beta.md'],
          result: {
            filename: 'unsafe-directive',
            name: 'Unsafe directive',
            description: 'Must be rejected',
            type: 'directive',
            content: 'Alpha and beta facts combined into a directive that must never be persisted.',
          },
          reason: 'unsafe escalation',
        }],
        conflicts: [],
      }),
    });

    const report = await consolidateLightMemory({
      dryRun: true,
      force: true,
      instructionFiles: [{ path: instructionsPath, content: instructions }],
    });

    expect(report.actions).toEqual([]);
    expect(report.diff).toContain('REJECTED');
    expect(await fs.readFile(path.join(memoryDir, 'alpha.md'), 'utf-8')).toBe(beforeAlpha);
    await expect(fs.stat(path.join(memoryDir, 'unsafe-directive.md'))).rejects.toThrow();
  });


// N-MEM-SOURCE-WRONG-FEEDBACK：被用户标记「不对/过时了」的来源在 consolidation 里优先处理
describe('user-flagged sources (N-MEM-SOURCE-WRONG-FEEDBACK)', () => {
  function flaggedMirrorDb(filename: string): FakeMemoryDb {
    const db = new FakeMemoryDb();
    db.records.push({
      id: 'mirror-1',
      type: 'project_knowledge',
      category: 'project',
      content: 'mirror body',
      source: 'user_defined',
      confidence: 1,
      metadata: {
        memoryEntry: { id: `light:${filename}`, sourceOfTruth: 'light_file', filePath: filename },
        injectionFeedback: { kind: 'wrong', at: 1_000, count: 1 },
      },
      status: 'active',
      accessCount: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    return db;
  }

  it('③ 有标记时穿过小库健康跳过：healthy 存量 + flagged 行也触发', async () => {
    await fs.rm(path.join(memoryDir, 'beta.md'));
    await fs.rm(path.join(memoryDir, 'conflict.md'));
    await fs.writeFile(path.join(memoryDir, 'INDEX.md'), [
      '# Memory Index',
      '',
      '- [alpha.md](alpha.md) — Release facts',
      '',
    ].join('\n'), 'utf-8');

    // 无标记：健康跳过（对照组）
    const skipped = await consolidateLightMemory({ dryRun: true, db: new FakeMemoryDb() });
    expect(skipped.triggered).toBe(false);

    const report = await consolidateLightMemory({ dryRun: true, db: flaggedMirrorDb('alpha.md') });
    expect(report.triggered).toBe(true);
    expect(report.reason).toContain('user-flagged');
  });

  it('③ 标记文件在 prompt 里排最前并点名「不得原样保留」', async () => {
    const report = await consolidateLightMemory({
      dryRun: true,
      force: true,
      db: flaggedMirrorDb('beta.md'),
      instructionFiles: [{ path: instructionsPath, content: instructions }],
    });
    expect(report.triggered).toBe(true);
    const prompt = mocks.memoryTask.mock.calls[0][0] as string;
    expect(prompt).toContain('标记为「不对/过时了」');
    expect(prompt).toContain('- beta.md');
    expect(prompt).toContain('不得原样保留');
    // beta.md（被标记）排在 alpha.md（未标记）前面
    expect(prompt.indexOf('### beta.md')).toBeLessThan(prompt.indexOf('### alpha.md'));
  });

  it('③ 审计行带 flaggedSources；撤销后（kind 清空）不再算标记', async () => {
    const db = flaggedMirrorDb('alpha.md');
    const report = await consolidateLightMemory({
      dryRun: false,
      force: true,
      db,
      instructionFiles: [{ path: instructionsPath, content: instructions }],
    });
    expect(report.applied).toBe(true);
    const auditLines = (await fs.readFile(
      path.join(memoryDir, MEMORY_CONSOLIDATION.AUDIT_FILENAME),
      'utf-8',
    )).trim().split('\n');
    const audits = auditLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audits.length).toBeGreaterThanOrEqual(2);
    for (const audit of audits) {
      expect(audit.flaggedSources).toEqual(['alpha.md']);
    }
  });
});
});
