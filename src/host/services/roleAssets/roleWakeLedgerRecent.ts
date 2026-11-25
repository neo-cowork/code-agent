import { ROLE_PROACTIVITY } from '../../../shared/constants';
import type {
  RoleWakeLedgerBasisCounts,
  RoleWakeLedgerRecentRow,
  RoleWakeLedgerStoredDecision,
} from '../../../shared/contract/roleAssets';
import { readWakeLedgerRows, type WakeLedgerStoredRow } from './roleWakeLedger';

const STORED_DECISIONS = new Set<RoleWakeLedgerStoredDecision>([
  'advance', 'report', 'suggest', 'silent', 'suppressed_duplicate',
]);

const REASON_CODES = new Set([
  'no_products',
  'excluded_topic',
  'previously_reported',
  'missing_decision',
  'work_advanced',
  'change_reported',
  'action_suggested',
  'no_action_needed',
]);

function basisIdsOf(row: WakeLedgerStoredRow): string[] {
  if (!Array.isArray(row.basisIds)) return [];
  return row.basisIds.filter((id) => typeof id === 'string' && id.length > 0);
}

function countNewBasis(current: string[], previous: string[]): RoleWakeLedgerBasisCounts {
  const seen = new Set(previous);
  const counted = new Set<string>();
  const counts: RoleWakeLedgerBasisCounts = { mail: 0, calendar: 0 };
  for (const id of current) {
    if (seen.has(id) || counted.has(id)) continue;
    counted.add(id);
    const kind = id.slice(0, id.indexOf(':'));
    if (kind === 'mail' || kind === 'calendar') counts[kind] += 1;
  }
  return counts;
}

function transportReason(reason: string): string {
  const trimmed = reason.replace(/\s+/g, ' ').trim();
  if (REASON_CODES.has(trimmed)) return trimmed;
  const cleaned = trimmed
    .replace(/(?:^|\s)(?:mail|calendar):[^\s,，。；;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'missing_decision';
}

function projectRow(row: WakeLedgerStoredRow, previousBasis: string[] | null): RoleWakeLedgerRecentRow | null {
  if (!STORED_DECISIONS.has(row.decision) || !Number.isFinite(row.at) || typeof row.reason !== 'string') return null;
  const recent: RoleWakeLedgerRecentRow = {
    at: row.at,
    decision: row.decision,
    reason: transportReason(row.reason),
    newBasis: previousBasis === null ? { mail: 0, calendar: 0 } : countNewBasis(basisIdsOf(row), previousBasis),
  };
  if (typeof row.firstReportedAt === 'number' && Number.isFinite(row.firstReportedAt)) {
    recent.firstReportedAt = row.firstReportedAt;
  }
  return recent;
}

export async function readRecentWakeDecisions(
  roleId: string,
  limit: number = ROLE_PROACTIVITY.WAKE_LEDGER_RECENT_ROWS,
): Promise<RoleWakeLedgerRecentRow[]> {
  const stored = await readWakeLedgerRows(roleId);
  const ordered = stored
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.at - b.row.at || a.index - b.index);
  const projected: RoleWakeLedgerRecentRow[] = [];
  for (let position = 0; position < ordered.length; position += 1) {
    const previous = position === 0 ? null : basisIdsOf(ordered[position - 1].row);
    const row = projectRow(ordered[position].row, previous);
    if (row) projected.push(row);
  }
  const cap = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, ROLE_PROACTIVITY.WAKE_LEDGER_MAX_ROWS)
    : ROLE_PROACTIVITY.WAKE_LEDGER_RECENT_ROWS;
  return projected.slice(-cap);
}
