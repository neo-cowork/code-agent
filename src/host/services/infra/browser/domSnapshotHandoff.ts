/**
 * Host-only handoff of the full DOM snapshot.
 *
 * The model-visible output and the persisted result metadata only carry a compact summary;
 * the managed-browser surface adapter still needs the full element list to build its
 * observation. The full record is parked here by snapshotId and consumed exactly once.
 */
import type { BrowserDomSnapshot } from './types';

const MAX_PARKED = 8;
const parked = new Map<string, BrowserDomSnapshot>();

export function parkHostDomSnapshot(snapshot: BrowserDomSnapshot): void {
  parked.delete(snapshot.snapshotId);
  parked.set(snapshot.snapshotId, snapshot);
  while (parked.size > MAX_PARKED) {
    const oldest = parked.keys().next().value;
    if (oldest === undefined) break;
    parked.delete(oldest);
  }
}

export function takeHostDomSnapshot(snapshotId: string): BrowserDomSnapshot | null {
  const snapshot = parked.get(snapshotId) ?? null;
  parked.delete(snapshotId);
  return snapshot;
}
