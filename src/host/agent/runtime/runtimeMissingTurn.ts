import type { ToolContext } from '../../protocol/tools';
import { EnvBlockedError } from '../../permissions/envAssist/EnvBlockedError';
import { getConfiguredApplicationRunRegistry } from '../../app/applicationRunRegistry';
import { isQuotaWaitParkableRun } from '../../runtime/quotaWaitParkability';

/** What shell env assembly reported about a runtime Neo installs itself (managedLibreOfficeEnv). */
export interface RuntimeRefusal {
  ok: false;
  code: string;
  envBlocked?: { class: 'runtime_missing'; target: string };
  waitable?: boolean;
}

/**
 * A shell command needs a runtime that is missing or still installing. A run that can wait parks on it (ADR-090 §3 row 7,
 * §7) and is resumed by the env-resume waiter once the install lands; every other run keeps the fail-closed result.
 */
export function parkMissingRuntime(refusal: RuntimeRefusal, ctx: Pick<ToolContext, 'runId' | 'currentToolCallId'>): void {
  if (!refusal.waitable || !refusal.envBlocked || !ctx.currentToolCallId) return;
  if (!isQuotaWaitParkableRun(getConfiguredApplicationRunRegistry(), ctx.runId)) return;
  throw new EnvBlockedError(refusal.envBlocked.class, refusal.envBlocked.target, ctx.currentToolCallId);
}
