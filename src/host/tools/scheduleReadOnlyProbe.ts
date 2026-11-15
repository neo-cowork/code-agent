import os from 'os';
import path from 'path';
import { writeGrantRootFromMetadata } from '../../shared/cronWriteScope';
import { getPermissionModeManager } from '../permissions/modes';
import { getPolicyEngine } from '../permissions/policyEngine';
import { resolveEffectivePolicyRules } from '../permissions/runPolicySnapshot';
import { getDatabase } from '../services/core/databaseService';
import { compileReadOnlyProbePlan } from '../security/readOnlyProbePlan';
import { authorizeProbePath } from '../security/readOnlyProbeExecutor';

/** Only an explicit, still-persisted cron folder grant can relax its Bash topology ask.
 * Every filesystem operand must be absolute and inside that grant, including realpath.
 * Unknown programs/operands keep the existing approval path.
 */
export function scheduleReadOnlyProbeRoot(sessionId: string | undefined, command: string): string | undefined {
  if (!sessionId || !getPermissionModeManager().isUnattendedSession(sessionId)) return undefined;
  try {
    const db = getDatabase();
    const origin = db.getSession(sessionId)?.origin;
    if (origin?.kind !== 'cron' || !origin.id) return undefined;
    const job = db.getDb()?.prepare('SELECT metadata FROM cron_jobs WHERE id = ?').get(origin.id) as { metadata?: string } | undefined;
    const metadata: unknown = JSON.parse(job?.metadata ?? '{}');
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
    const root = writeGrantRootFromMetadata(metadata as Record<string, unknown>);
    if (!root || path.parse(root).root === root) return undefined;
    const plan = compileReadOnlyProbePlan(command, { homeDir: os.homedir(), platform: process.platform });
    if (!plan) return undefined;
    const rules = resolveEffectivePolicyRules(sessionId);
    // The existing safe-command shortcut runs before the probe hook. Recheck each
    // fragment here too, so its shortcut cannot hide a user's ask/deny on a tail.
    for (const source of [command, ...plan.steps.flatMap((step) => [step.source, ...step.extraSources ?? []])]) {
      for (const tool of ['Bash', 'bash']) {
        const matched = getPolicyEngine().evaluate({ tool, level: 'execute', command: source, description: `tool: ${tool}`, sessionId }, rules).matchedRule;
        if (matched && matched.action !== 'allow') return undefined;
      }
    }
    let hasPath = false;
    for (const { cmd } of plan.steps) {
      const paths = cmd.kind === 'ls' ? cmd.paths : cmd.kind === 'test' ? [cmd.path]
        : cmd.kind === 'file-loop' ? [cmd.directory, ...cmd.files.map((file) => file.path)] : undefined;
      if (paths) {
        if (!paths.length) return undefined;
        for (const operand of paths) {
          if (!path.isAbsolute(operand) || !authorizeProbePath(operand, {
            workingDirectory: root, homeDir: os.homedir(), userTexts: [], attachmentPaths: [],
          })) return undefined;
          hasPath = true;
        }
      } else if (!['noop', 'echo', 'printf'].includes(cmd.kind)) return undefined;
    }
    return hasPath ? root : undefined;
  } catch {
    return undefined;
  }
}
