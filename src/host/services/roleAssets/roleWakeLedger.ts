import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { ROLE_PROACTIVITY } from '../../../shared/constants';
import type { RoleWakeDecision, RoleWakeFunnel, RoleWakeTrigger } from '../../../shared/contract/roleAssets';
import { createLogger } from '../infra/logger';
import { getProjectKey, getRoleWakeLedgerPath } from './roleAssetPaths';

const logger = createLogger('RoleWakeLedger');
const DAY_MS = 24 * 60 * 60 * 1000;
const writes = new Map<string, Promise<boolean>>();

export interface WakeLedgerStoredRow {
  id: string;
  at: number;
  trigger: RoleWakeTrigger;
  workspaceKey: string | null;
  decision: Exclude<RoleWakeDecision, 'silence'> | 'silent' | 'suppressed_duplicate';
  reason: string;
  basisIds: string[];
  fallbackDecision?: true;
  duplicateOf?: string;
  firstReportedAt?: number;
}

interface WakeLedgerDecision {
  decision: RoleWakeDecision;
  finalOutput?: string;
  rationale?: string;
  summary?: string;
  silenceReason?: 'excluded_topic' | 'no_products';
  /** Keeps the host's all-sources-unreadable diagnostic visible. */
  preserveReport?: boolean;
}

export const WAKE_LEDGER_PROMPT = [
  '6. 每种决策末尾都加一句 <rationale>本次决策的理由</rationale>（已写理由就不要重复），并紧接 <basis>id1,id2</basis>。',
  '   只填决策实际依据的外部对象原始编号，用逗号分隔。邮件列表或正文的 #编号 写成 mail:编号；日历列表的 uid 写成 calendar:原样uid。',
  '   没有外部依据就写 <basis></basis>。不要编造编号，不要把编号和标签写进给用户看的正文。',
] as const;

function parseBasisIds(output: string): string[] {
  const basis = output.match(ROLE_PROACTIVITY.BASIS_TAG_PATTERN)?.[1]?.trim();
  if (!basis) return [];
  const ids = basis.split(',').map((id) => id.trim());
  // Dropping just one malformed id could make a mixed old/new report look fully covered.
  if (ids.some((id) => !/^[\w#@.:%+=/-]{1,512}$/.test(id))) return [];
  return [...new Set(ids)];
}

async function readRows(file: string): Promise<WakeLedgerStoredRow[]> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return content.split('\n').filter(Boolean).map((line) => JSON.parse(line) as WakeLedgerStoredRow);
}

export async function readWakeLedgerRows(roleId: string): Promise<WakeLedgerStoredRow[]> {
  return readRows(getRoleWakeLedgerPath(roleId));
}

function firstReportCoveringBasis(rows: WakeLedgerStoredRow[], row: WakeLedgerStoredRow): WakeLedgerStoredRow | undefined {
  const cutoff = row.at - ROLE_PROACTIVITY.WAKE_LEDGER_DEDUP_DAYS * DAY_MS;
  const covered = new Set<string>();
  const basisIds = new Set(row.basisIds);
  let first: WakeLedgerStoredRow | undefined;
  for (const previous of rows) {
    if (previous.decision !== 'report' || previous.workspaceKey !== row.workspaceKey || previous.at < cutoff) continue;
    for (const id of previous.basisIds) {
      if (!basisIds.has(id)) continue;
      covered.add(id);
      if (!first || previous.at < first.at) first = previous;
    }
  }
  return covered.size === basisIds.size ? first : undefined;
}

/** Serialize read, dedup and atomic replacement per role, including overlapping cadence/event wakes. */
export async function recordWakeDecision(
  roleId: string,
  trigger: RoleWakeTrigger,
  workspacePath: string | undefined,
  at: number,
  input: WakeLedgerDecision,
): Promise<RoleWakeDecision> {
  const file = getRoleWakeLedgerPath(roleId);
  const fallbackDecision = input.finalOutput !== undefined && !ROLE_PROACTIVITY.DECISION_TAG_PATTERN.test(input.finalOutput);
  const reason = (input.rationale || input.summary)?.replace(/\s+/g, ' ').trim();
  const row: WakeLedgerStoredRow = {
    id: randomUUID(),
    at,
    trigger,
    workspaceKey: workspacePath ? getProjectKey(workspacePath) : null,
    decision: input.decision === 'silence' ? 'silent' : input.decision,
    reason: input.silenceReason ?? reason?.match(/^.*?(?:[。！？]|[.!?](?=\s|$))/)?.[0]
      ?? (reason || (fallbackDecision ? 'missing_decision' : rowReason(input.decision))),
    basisIds: parseBasisIds(input.finalOutput ?? ''),
    ...(fallbackDecision ? { fallbackDecision: true } : {}),
  };

  const write = (writes.get(file) ?? Promise.resolve(false)).then(async () => {
    const rows = await readRows(file);
    if (row.decision === 'report' && !input.preserveReport && !row.fallbackDecision && row.basisIds.length > 0) {
      const first = firstReportCoveringBasis(rows, row);
      if (first) {
        row.decision = 'suppressed_duplicate';
        row.reason = 'previously_reported';
        row.duplicateOf = first.id;
        row.firstReportedAt = first.at;
      }
    }
    const retained = [...rows, row].slice(-ROLE_PROACTIVITY.WAKE_LEDGER_MAX_ROWS);
    const temp = `${file}.tmp-${row.id}`;
    try {
      await fs.writeFile(temp, retained.map((entry) => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true });
    }
    return row.decision === 'suppressed_duplicate';
  }).catch((error: unknown) => {
    logger.warn('Wake decision ledger write failed', { roleId, error: String(error) });
    return false;
  });
  writes.set(file, write);
  const suppressed = await write;
  if (writes.get(file) === write) writes.delete(file);
  if (suppressed) logger.info('Wake report suppressed as duplicate', { roleId, rowId: row.id, duplicateOf: row.duplicateOf });
  return suppressed ? 'silence' : input.decision;
}

function rowReason(decision: RoleWakeDecision): string {
  return {
    advance: 'work_advanced',
    report: 'change_reported',
    suggest: 'action_suggested',
    silence: 'no_action_needed',
  }[decision];
}

export async function readRoleWakeFunnel(roleId: string): Promise<RoleWakeFunnel> {
  const rows = await readRows(getRoleWakeLedgerPath(roleId));
  const cutoff = Date.now() - ROLE_PROACTIVITY.WAKE_LEDGER_FUNNEL_DAYS * DAY_MS;
  const funnel: RoleWakeFunnel = { wakes: 0, reports: 0, suppressed: 0, fallbackSent: 0, duplicates: [] };
  for (const row of rows) {
    if (row.at < cutoff) continue;
    funnel.wakes++;
    if (row.decision === 'report') {
      funnel.reports++;
      if (row.fallbackDecision) funnel.fallbackSent++;
    } else if (row.decision === 'suppressed_duplicate') {
      funnel.suppressed++;
      if (row.firstReportedAt !== undefined) funnel.duplicates.push({ at: row.at, firstReportedAt: row.firstReportedAt });
    }
  }
  funnel.duplicates.sort((a, b) => b.at - a.at);
  return funnel;
}
