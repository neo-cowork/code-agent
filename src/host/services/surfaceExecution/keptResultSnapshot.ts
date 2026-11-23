// In-memory HTML snapshot for a kept result page.
// A direct POST or a one-time flash cannot be restored by navigating to the stored
// URL. Reopen shows this snapshot when the URL has no query string. A URL with a
// query (PRG id) keeps today's navigate-to-URL behaviour. The HTML stays on the
// registry entry only: never written to disk, dropped when the entry is replaced.

import { KEPT_RESULT_PAGE_SNAPSHOT_MAX_CHARS } from '../../../shared/constants';
import type { KeptResultReopenMode } from '../../../shared/ipc/types';
import { createLogger } from '../infra/logger';

const logger = createLogger('KeptResultSnapshot');

export type KeptResultSnapshotPhase = 'keep' | 'release';

interface SnapshotTarget {
  reason: string;
  parkedForUser?: boolean;
  state: string;
  serviceKey: string;
}

interface KeptResultSnapshotStore {
  get(conversationId: string): SnapshotTarget | null;
  setSnapshot(conversationId: string, html: string, serviceKey: string): boolean;
}

/** `?` before a hash counts, including an empty query. A hash alone does not. */
function storedUrlHasQueryString(url: string): boolean {
  const hashAt = url.indexOf('#');
  const queryAt = url.indexOf('?');
  return queryAt >= 0 && (hashAt < 0 || queryAt < hashAt);
}

/**
 * Reopen target. Snapshot only when HTML is stored and the URL has no query
 * string. A query string (a PRG id) stays on today's URL path. A hash alone
 * is not a query string.
 */
export function keptResultReopenMode(input: {
  url: string;
  snapshotHtml?: string | null;
}): KeptResultReopenMode {
  if (!input.snapshotHtml) return 'url';
  return storedUrlHasQueryString(input.url) ? 'url' : 'snapshot';
}

function warnCaptureFailed(phase: KeptResultSnapshotPhase, error: unknown): void {
  logger.warn('Kept result snapshot capture failed', {
    reason: phase === 'keep' ? 'keep_snapshot_capture_failed' : 'release_snapshot_capture_failed',
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Read the live page and store it on the keep_result_page entry.
 * Never throws. Over-cap and empty pages are not stored. Takeover and
 * parked-for-user entries are left alone.
 */
export async function captureKeptResultSnapshot(input: {
  registry: KeptResultSnapshotStore;
  conversationId: string;
  serviceKey: string;
  getPageHTML: () => Promise<string>;
  phase: KeptResultSnapshotPhase;
}): Promise<void> {
  try {
    const current = input.registry.get(input.conversationId);
    if (current?.reason !== 'keep_result_page' || current.parkedForUser || current.state !== 'kept') return;
    if (current.serviceKey !== input.serviceKey) return;

    let html: string;
    try {
      html = await input.getPageHTML();
    } catch (error) {
      warnCaptureFailed(input.phase, error);
      return;
    }
    if (!html.trim()) {
      logger.warn('Kept result snapshot empty; not stored', {
        reason: 'snapshot_empty',
        phase: input.phase,
        conversationId: input.conversationId,
      });
      return;
    }
    if (html.length > KEPT_RESULT_PAGE_SNAPSHOT_MAX_CHARS) {
      logger.warn('Kept result snapshot over cap; not stored', {
        reason: 'snapshot_over_cap',
        phase: input.phase,
        conversationId: input.conversationId,
        chars: html.length,
        cap: KEPT_RESULT_PAGE_SNAPSHOT_MAX_CHARS,
      });
      return;
    }
    const stored = input.registry.setSnapshot(input.conversationId, html, input.serviceKey);
    if (!stored) {
      logger.warn('Kept result snapshot not stored; no live result entry', {
        reason: 'snapshot_no_entry',
        phase: input.phase,
        conversationId: input.conversationId,
      });
      return;
    }
    logger.info(`Kept result snapshot captured (${input.phase}, conversation ${input.conversationId}, ${html.length} chars)`);
  } catch (error) {
    warnCaptureFailed(input.phase, error);
  }
}
