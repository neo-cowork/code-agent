import type { MemoryChangeJournalContext } from '../../shared/contract/memory';
import type { MemoryRecord } from '../protocol/types';
import { getDatabase } from '../services/core/databaseService';

/** Snapshots contain the persisted body, so undo does not insert frontmatter into the body. */
function snapshot(source: string): Pick<MemoryRecord, 'summary' | 'status' | 'content'> {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const header = match?.[1] ?? '';
  return {
    summary: header.match(/^name:\s*(.*)$/m)?.[1]?.trim(),
    status: (header.match(/^status:\s*(.*)$/m)?.[1]?.trim() ?? 'active') as MemoryRecord['status'],
    content: (match?.[2] ?? source).trim(),
  };
}

export function journalScopedMemoryChange(
  entryId: string,
  before: string | null,
  after: string,
  journal: MemoryChangeJournalContext,
): void {
  getDatabase().appendFileMemoryJournal({
    entryId,
    before: before === null ? null : snapshot(before),
    after: snapshot(after),
    journal,
  });
}
