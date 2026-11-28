import type { RunEnvelope } from '../../../shared/contract/durableRun';

/**
 * Per-run note of why a parked tool call is waiting (login_expired / offline / permission).
 * Kept in its own module so the notice layer (toolNotice.ts) can read it without pulling the
 * whole envBlockedTurn graph — which reaches parkedCallApproval → … → services/core and would
 * break host contexts that stub only the notice storage (shellBridgeProduction child).
 */
const notes = new Map<string, NonNullable<RunEnvelope['envBlocked']>>();

export function peekEnvBlockedNote(runId: string | undefined): RunEnvelope['envBlocked'] { return runId ? notes.get(runId) : undefined; }
export function hasEnvBlockedNote(runId: string): boolean { return notes.has(runId); }
export function setEnvBlockedNote(runId: string, note: NonNullable<RunEnvelope['envBlocked']>): void { notes.set(runId, note); }
export function clearEnvBlockedNote(runId: string): void { notes.delete(runId); }
