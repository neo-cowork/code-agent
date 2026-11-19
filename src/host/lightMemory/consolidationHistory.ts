// ============================================================================
// Light Memory Consolidation History — 最近整理列表 + 一键恢复
// （N-MEM-CONSOLIDATION-HISTORY-UNDO）
//
// 审计文件（consolidation-audit.jsonl）是真源：每次真跑追加一行，恢复再追加
// kind:'restored' 行。本模块只读它出「最近整理」列表，并把一次整理恢复原样：
//   - 来源卡 → active、清掉 deprecated_by
//   - 合并产物卡 → archived（不删文件）
//   - 冲突卡（记录里有原文快照的）→ 原状态 + 原正文
//   - INDEX 指针还原 + SQLite 镜像重建
// 恢复中途失败：记录已改动文件、不落 restored 行（行保持可恢复，重试幂等）。
// 旧记录（无快照）：合并部分可恢复，冲突部分只读展示。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MEMORY_CONSOLIDATION } from '../../shared/constants';
import type {
  MemoryEntryStatus,
  MemoryTidyConflictView,
  MemoryTidyHistoryResult,
  MemoryTidyMergeView,
  MemoryTidyPreviewView,
  MemoryTidyRestoreResult,
  MemoryTidyRunView,
} from '../../shared/contract/memory';
import { createLogger } from '../services/infra/logger';
import { getMemoryDir } from './indexLoader';
import { readMemoryFile, updateLightMemoryIndexPointers, writeLightMemoryFile } from './lightMemoryIpc';
import { rebuildMemoryMirrorFromLightFiles, type MemoryEntryDatabase } from '../memory/memoryEntryRuntime';
import { atomicWriteMemoryText } from '../memory/atomicMemoryFile';

const logger = createLogger('MemoryConsolidationHistory');

/** 审计行里 merges[].result 的宽松形状（v1 行只有 filename/entryId，v2 行带产物卡快照）。 */
interface AuditMerge {
  sources?: string[];
  result?: {
    filename?: string;
    entryId?: string;
    name?: string;
    description?: string;
    type?: string;
    content?: string;
  } | null;
}

/** 审计行里 conflicts[] 的宽松形状（v2 行额外带 original 原文快照）。 */
interface AuditConflict {
  source?: string;
  status?: string;
  reason?: string;
  original?: { status?: string; content?: string } | null;
}

/** 审计行宽松形状（读取端对缺字段/未知字段一律宽容，v1/v2 混读）。 */
interface AuditLine {
  schemaVersion?: number;
  kind?: string;
  auditId?: string;
  restoresAuditId?: string;
  at?: number;
  outcome?: string;
  reason?: string;
  before?: { fileCount?: number };
  after?: { fileCount?: number };
  merges?: AuditMerge[];
  conflicts?: AuditConflict[];
  changedFiles?: string[];
}

/** 演练预览文件的磁盘形状（consolidation.ts 的 dry-run 写入）。 */
interface ConsolidationPreviewFile {
  schemaVersion: number;
  at: number;
  wouldChangeNothing: boolean;
  reason: string;
  merges: Array<{ sources: string[]; result: { filename: string; name: string; description: string } }>;
  conflicts: Array<{ source: string; status: string; reason: string }>;
}

const PREVIEW_SCHEMA_VERSION = 1;

function auditPath(): string {
  return path.join(getMemoryDir(), MEMORY_CONSOLIDATION.AUDIT_FILENAME);
}

function previewPath(): string {
  return path.join(getMemoryDir(), MEMORY_CONSOLIDATION.PREVIEW_FILENAME);
}

/** 读审计文件尾部行（缺文件返回空数组；坏行由调用方逐行宽容解析）。 */
async function readAuditTailLines(): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(auditPath(), 'utf-8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  return lines.slice(-MEMORY_CONSOLIDATION.HISTORY_TAIL_LINES);
}

function parseAuditLine(line: string): AuditLine | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as AuditLine;
  } catch {
    logger.warn('Consolidation audit line unparsable, skipped', { line: line.slice(0, 120) });
    return null;
  }
}

/**
 * 演练预览落盘（consolidation.ts 的 dry-run 调用）：只保留最近一次，原子覆盖。
 * 只存出预告句所需的名字/摘要，不存正文——预览不是完整快照。
 */
export async function writeConsolidationPreviewFile(input: {
  wouldChangeNothing: boolean;
  reason: string;
  merges: Array<{ sources: string[]; result: { filename: string; name: string; description: string } }>;
  conflicts: Array<{ source: string; status: string; reason: string }>;
}): Promise<void> {
  const payload: ConsolidationPreviewFile = {
    schemaVersion: PREVIEW_SCHEMA_VERSION,
    at: Date.now(),
    wouldChangeNothing: input.wouldChangeNothing,
    reason: input.reason,
    merges: input.merges.map((merge) => ({
      sources: merge.sources,
      result: {
        filename: merge.result.filename,
        name: merge.result.name,
        description: merge.result.description,
      },
    })),
    conflicts: input.conflicts,
  };
  await atomicWriteMemoryText(previewPath(), JSON.stringify(payload, null, 2));
}

async function readConsolidationPreviewFile(): Promise<ConsolidationPreviewFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(previewPath(), 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as ConsolidationPreviewFile;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.at !== 'number') return null;
    return parsed;
  } catch (error) {
    logger.warn('Consolidation preview unparsable, ignored', { error });
    return null;
  }
}

/** 文件名 → 人话名解析：优先当前文件 frontmatter，回落快照名，再回落文件名本身。 */
async function resolveDisplayNames(
  filenames: string[],
  fallbackNames: Map<string, string>,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  await Promise.all(Array.from(new Set(filenames)).map(async (filename) => {
    const file = await readMemoryFile(filename);
    resolved.set(filename, file?.name || fallbackNames.get(filename) || filename);
  }));
  return resolved;
}

function mergeView(
  merge: AuditMerge,
  names: Map<string, string>,
): MemoryTidyMergeView {
  const sources = (merge.sources ?? []).filter((source): source is string => typeof source === 'string');
  const resultFilename = merge.result?.filename ?? '';
  // 产物卡名字：优先快照（v2 行），回落当前文件（旧行产物卡仍在盘上），最后文件名。
  const resultName = merge.result?.name || names.get(resultFilename) || resultFilename;
  return {
    sources: sources.map((source) => ({ filename: source, name: names.get(source) || source })),
    result: {
      filename: resultFilename,
      name: resultName,
      summary: merge.result?.description || resultName,
    },
  };
}

function conflictView(
  conflict: AuditConflict,
  names: Map<string, string>,
): MemoryTidyConflictView {
  const source = typeof conflict.source === 'string' ? conflict.source : '';
  return {
    source: { filename: source, name: names.get(source) || source },
    reason: typeof conflict.reason === 'string' ? conflict.reason : '',
    restorable: conflict.original != null
      && typeof conflict.original.content === 'string'
      && typeof conflict.original.status === 'string',
  };
}

/** 恢复可执行性判定（列表展示与恢复前置校验共用同一份规则）。 */
function evalRestorability(line: AuditLine, restored: boolean): {
  restorable: boolean;
  blockedCode?: MemoryTidyRunView['blockedCode'];
} {
  if (restored) return { restorable: false, blockedCode: 'already-restored' };
  if (line.outcome !== 'applied') return { restorable: false, blockedCode: 'not-applied' };
  const hasRestorableMerge = (line.merges ?? []).some((merge) => typeof merge.result?.filename === 'string');
  const hasRestorableConflict = (line.conflicts ?? []).some(
    (conflict) => conflictView(conflict, new Map()).restorable,
  );
  if (hasRestorableMerge || hasRestorableConflict) return { restorable: true };
  return { restorable: false, blockedCode: 'snapshot-missing' };
}

/**
 * 「最近整理」列表：审计尾部按 auditId 去重取终态行（pending→终态两行同 id），
 * 新在前，cap HISTORY_MAX_RUNS；附带最近一次演练预览。
 */
export async function listConsolidationRuns(): Promise<MemoryTidyHistoryResult> {
  const lines = (await readAuditTailLines())
    .map(parseAuditLine)
    .filter((line): line is AuditLine => line !== null);

  const restoredAtByAuditId = new Map<string, number>();
  const lastLineByAuditId = new Map<string, AuditLine>();
  for (const line of lines) {
    if (line.kind === 'restored' && typeof line.restoresAuditId === 'string') {
      restoredAtByAuditId.set(line.restoresAuditId, line.at ?? Date.now());
      continue;
    }
    if (typeof line.auditId === 'string') lastLineByAuditId.set(line.auditId, line);
  }

  const newestFirst = Array.from(lastLineByAuditId.entries()).reverse()
    .slice(0, MEMORY_CONSOLIDATION.HISTORY_MAX_RUNS);

  const snapshotNames = new Map<string, string>();
  for (const [, line] of newestFirst) {
    for (const merge of line.merges ?? []) {
      if (merge.result?.filename && merge.result.name) {
        snapshotNames.set(merge.result.filename, merge.result.name);
      }
    }
  }
  const allFilenames = newestFirst.flatMap(([, line]) => [
    ...(line.merges ?? []).flatMap((merge) => [
      ...(merge.sources ?? []),
      merge.result?.filename ?? '',
    ]),
    ...(line.conflicts ?? []).map((conflict) => conflict.source ?? ''),
  ]).filter((filename) => filename.length > 0);
  const names = await resolveDisplayNames(allFilenames, snapshotNames);

  const runs: MemoryTidyRunView[] = newestFirst.map(([auditId, line]) => {
    const restoredAt = restoredAtByAuditId.get(auditId) ?? null;
    const { restorable, blockedCode } = evalRestorability(line, restoredAt !== null);
    const beforeCount = typeof line.before?.fileCount === 'number' ? line.before.fileCount : 0;
    const afterCount = typeof line.after?.fileCount === 'number' ? line.after.fileCount : 0;
    return {
      auditId,
      at: line.at ?? 0,
      outcome: (line.outcome ?? 'skipped') as MemoryTidyRunView['outcome'],
      reason: typeof line.reason === 'string' ? line.reason : '',
      mergeCount: line.merges?.length ?? 0,
      conflictCount: line.conflicts?.length ?? 0,
      netPutAway: beforeCount - afterCount,
      merges: (line.merges ?? []).map((merge) => mergeView(merge, names)),
      conflicts: (line.conflicts ?? []).map((conflict) => conflictView(conflict, names)),
      restored: restoredAt !== null,
      restoredAt,
      restorable,
      ...(blockedCode ? { blockedCode } : {}),
    };
  }).sort((left, right) => right.at - left.at);

  const previewFile = await readConsolidationPreviewFile();
  let preview: MemoryTidyPreviewView | null = null;
  if (previewFile) {
    const previewNames = await resolveDisplayNames([
      ...previewFile.merges.flatMap((merge) => merge.sources),
      ...previewFile.conflicts.map((conflict) => conflict.source),
    ], new Map());
    preview = {
      at: previewFile.at,
      wouldChangeNothing: previewFile.wouldChangeNothing === true,
      reason: previewFile.reason,
      merges: previewFile.merges.map((merge) => mergeView(merge, previewNames)),
      conflicts: previewFile.conflicts.map((conflict) => conflictView(conflict, previewNames)),
    };
  }

  return { runs, preview };
}

function restoredLinePayload(auditId: string, at: number, changedFiles: string[]): string {
  return `${JSON.stringify({
    schemaVersion: 2,
    kind: 'restored',
    restoresAuditId: auditId,
    at,
    changedFiles,
  })}\n`;
}

/**
 * 把一次已生效的整理恢复原样。拒绝走 typed code 返回（不向 UI 抛异常）；
 * 恢复中途失败：返回 restore-failed + 已改动文件清单（同步记日志），不落 restored 行。
 */
export async function restoreConsolidationRun(input: {
  auditId: string;
  db: MemoryEntryDatabase;
}): Promise<MemoryTidyRestoreResult> {
  const auditId = input.auditId?.trim();
  if (!auditId) {
    return { ok: false, code: 'run-not-found', message: 'restore requires auditId' };
  }

  const lines = (await readAuditTailLines())
    .map(parseAuditLine)
    .filter((line): line is AuditLine => line !== null);
  let runLine: AuditLine | null = null;
  let restoredAt: number | null = null;
  for (const line of lines) {
    if (line.kind === 'restored' && line.restoresAuditId === auditId) {
      restoredAt = line.at ?? Date.now();
    }
    if (typeof line.auditId === 'string' && line.auditId === auditId) {
      runLine = line;
    }
  }
  if (!runLine) {
    return { ok: false, code: 'run-not-found', message: `no audit line for ${auditId}` };
  }
  if (restoredAt !== null) {
    return { ok: false, code: 'already-restored', message: `run ${auditId} restored at ${restoredAt}` };
  }
  const { restorable, blockedCode } = evalRestorability(runLine, false);
  if (!restorable) {
    return { ok: false, code: blockedCode ?? 'snapshot-missing', message: `run ${auditId} not restorable` };
  }

  // 计划收紧成可恢复的最小形状（来源/产物文件名、冲突原文），非空断言零告警。
  const merges = (runLine.merges ?? []).flatMap((merge): Array<{
    sources: string[];
    resultFilename: string;
  }> => {
    if (typeof merge.result?.filename !== 'string') return [];
    return [{
      sources: (merge.sources ?? []).filter((source): source is string => typeof source === 'string'),
      resultFilename: merge.result.filename,
    }];
  });
  const conflicts = (runLine.conflicts ?? []).flatMap((conflict): Array<{
    source: string;
    original: { status: string; content: string };
  }> => {
    if (typeof conflict.source !== 'string') return [];
    const original = conflict.original;
    if (!original || typeof original.status !== 'string' || typeof original.content !== 'string') return [];
    return [{ source: conflict.source, original: { status: original.status, content: original.content } }];
  });

  // 前置存在性校验：任何要写的文件缺失都整单拒绝（不在半途留部分状态）。
  for (const merge of merges) {
    for (const source of merge.sources) {
      if (!(await readMemoryFile(source))) {
        return { ok: false, code: 'source-file-missing', message: `source file missing: ${source}` };
      }
    }
    if (!(await readMemoryFile(merge.resultFilename))) {
      return {
        ok: false,
        code: 'source-file-missing',
        message: `merged card missing: ${merge.resultFilename}`,
      };
    }
  }
  for (const conflict of conflicts) {
    if (!(await readMemoryFile(conflict.source))) {
      return { ok: false, code: 'source-file-missing', message: `conflict source missing: ${conflict.source}` };
    }
  }

  const changedFiles: string[] = [];
  const reactivateIndex: Array<{ filename: string; description: string }> = [];
  try {
    for (const merge of merges) {
      for (const source of merge.sources) {
        const current = await readMemoryFile(source);
        if (!current) throw new Error(`source disappeared before restore: ${source}`);
        await writeLightMemoryFile({
          filename: current.filename,
          name: current.name,
          description: current.description,
          type: current.type,
          content: current.content,
          entryId: current.entryId,
          status: 'active',
          deprecatedBy: undefined,
          source: current.source,
          memoryTainted: current.memoryTainted,
          schemaVersion: current.schemaVersion,
          scope: current.scope,
          projectPath: current.projectPath,
          sessionId: current.sessionId,
          importProvenance: current.importProvenance,
          directiveConfirmedByUser: current.type === 'directive',
        });
        changedFiles.push(current.filename);
        reactivateIndex.push({ filename: current.filename, description: current.description });
      }
      const card = await readMemoryFile(merge.resultFilename);
      if (!card) throw new Error(`merged card disappeared before restore: ${merge.resultFilename}`);
      await writeLightMemoryFile({
        filename: card.filename,
        name: card.name,
        description: card.description,
        type: card.type,
        content: card.content,
        entryId: card.entryId,
        status: 'archived',
        deprecatedBy: undefined,
        source: card.source,
        memoryTainted: card.memoryTainted,
        schemaVersion: card.schemaVersion,
        scope: card.scope,
        projectPath: card.projectPath,
        sessionId: card.sessionId,
        importProvenance: card.importProvenance,
        directiveConfirmedByUser: card.type === 'directive',
      });
      changedFiles.push(card.filename);
    }

    for (const conflict of conflicts) {
      const current = await readMemoryFile(conflict.source);
      if (!current) throw new Error(`conflict source disappeared before restore: ${conflict.source}`);
      const originalStatus = (conflict.original.status as MemoryEntryStatus) || 'active';
      await writeLightMemoryFile({
        filename: current.filename,
        name: current.name,
        description: current.description,
        type: current.type,
        content: conflict.original.content,
        entryId: current.entryId,
        status: originalStatus,
        deprecatedBy: current.deprecatedBy,
        source: current.source,
        memoryTainted: current.memoryTainted,
        schemaVersion: current.schemaVersion,
        scope: current.scope,
        projectPath: current.projectPath,
        sessionId: current.sessionId,
        importProvenance: current.importProvenance,
        directiveConfirmedByUser: current.type === 'directive',
      });
      changedFiles.push(current.filename);
      if (originalStatus === 'active') {
        reactivateIndex.push({ filename: current.filename, description: current.description });
      }
    }

    await updateLightMemoryIndexPointers({
      remove: merges.map((merge) => merge.resultFilename),
      add: reactivateIndex,
    });
    const mirror = await rebuildMemoryMirrorFromLightFiles(input.db, { journal: { actor: 'user_manual' } });
    if (mirror.skipped.length > 0) {
      throw new Error(`DB mirror synchronization skipped ${mirror.skipped.length} file(s)`);
    }

    const restoredAtNow = Date.now();
    await fs.mkdir(path.dirname(auditPath()), { recursive: true });
    await fs.appendFile(auditPath(), restoredLinePayload(auditId, restoredAtNow, changedFiles), 'utf-8');
    logger.info('Consolidation restored', { auditId, changedFiles: changedFiles.length });
    return { ok: true, restoredAt: restoredAtNow };
  } catch (error) {
    logger.error('Consolidation restore failed midway', {
      auditId,
      changedFiles,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      code: 'restore-failed',
      message: error instanceof Error ? error.message : String(error),
      changedFiles,
    };
  }
}
