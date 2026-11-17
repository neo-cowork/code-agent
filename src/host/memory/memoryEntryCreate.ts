import type {
  MemoryChangeJournalContext,
  MemoryEntry,
  MemoryEntryCreateRequest,
  MemoryEntryCreateResult,
  MemoryEntryKind,
} from '../../shared/contract/memory';
import {
  buildActiveMemoryEntryFromInbox,
  createMemoryMirrorRecord,
  listUnifiedMemoryEntries,
  writeEntryToLightMemory,
  type MemoryEntryDatabase,
} from './memoryEntryRuntime';

/** 设置面板「添加记忆」允许的类型；directive/session/pattern 一律拒绝 */
const MANUAL_CREATE_KINDS: ReadonlySet<string> = new Set(['user', 'feedback', 'project', 'reference']);

/** 面向渲染层的错误码（渲染层映射成大白话） */
const MEMORY_CREATE_ERROR = {
  EMPTY: 'MEMORY_CREATE_EMPTY',
  KIND_FORBIDDEN: 'MEMORY_CREATE_KIND_FORBIDDEN',
} as const;

function normalizeForCompare(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export async function createManualMemoryEntry(
  db: MemoryEntryDatabase,
  request: MemoryEntryCreateRequest | undefined,
  journal: MemoryChangeJournalContext,
): Promise<MemoryEntryCreateResult> {
  const content = (request?.content ?? '').trim();
  if (!content) throw new Error(MEMORY_CREATE_ERROR.EMPTY);
  const kind = request?.kind;
  if (!kind || !MANUAL_CREATE_KINDS.has(kind)) throw new Error(MEMORY_CREATE_ERROR.KIND_FORBIDDEN);

  const normalized = normalizeForCompare(content);
  const { entries } = await listUnifiedMemoryEntries(db);
  const existing = entries.find((entry) => entry.status === 'active' && normalizeForCompare(entry.content) === normalized);
  if (existing) return { created: false, duplicate: true, entry: existing };

  const projectPath = kind === 'project' ? request?.projectPath?.trim() || null : null;
  const now = Date.now();
  const built = buildActiveMemoryEntryFromInbox({
    candidateId: `manual:${now}:${Math.random().toString(36).slice(2, 10)}`,
    content,
    title: content,
    source: 'manual',
    reason: content,
    projectPath,
    now,
  });
  const activeEntry: MemoryEntry = {
    ...built,
    kind: kind as MemoryEntryKind,
    scope: kind === 'project' ? 'project' : 'global',
    source: { ...built.source, kind: 'manual' },
  };
  const file = await writeEntryToLightMemory(activeEntry);
  const mirrored: MemoryEntry = {
    ...activeEntry,
    source: { ...activeEntry.source, filePath: file.filename, label: `~/.code-agent/memory/${file.filename}` },
    updatedAt: Date.parse(file.updatedAt) || activeEntry.updatedAt,
  };
  createMemoryMirrorRecord(db, mirrored, { journal });
  return { created: true, duplicate: false, entry: mirrored };
}
