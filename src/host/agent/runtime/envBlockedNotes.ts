import type { RunEnvelope } from '../../../shared/contract/durableRun';

/**
 * The per-run "this run parked on an environment blocker" note. Kept apart from envBlockedTurn so the env-assist card
 * code can read it without pulling the whole tool-execution graph into the IPC entry (a module cycle through
 * services/core otherwise breaks the production bridge entry).
 */
export const envBlockedNotes = new Map<string, NonNullable<RunEnvelope['envBlocked']>>();
export function peekEnvBlockedNote(runId: string | undefined): RunEnvelope['envBlocked'] { return runId ? envBlockedNotes.get(runId) : undefined; }
export function clearEnvBlockedNote(runId: string): void { envBlockedNotes.delete(runId); }
