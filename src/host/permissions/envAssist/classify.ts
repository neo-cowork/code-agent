import type { EnvAssistNotice, EnvBlockerClass } from '../../../shared/contract/envAssist';
import { detectScreenshotFailureCause } from './screenshotFailureCause';

const AUTOMATION_TARGETS: Readonly<Record<string, string>> = {
  calendar: 'calendar', mail: 'mail', reminders: 'reminders', reminders_create: 'reminders',
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Only S1's three permission classes are actionable; other failures remain with their owners. */
export function classifyEnvBlocker(input: {
  toolName: string; result: unknown; sessionId: string; runId: string;
}): EnvAssistNotice | null {
  const result = record(input.result);
  if (result.success !== false && result.ok !== false) return null;
  const metadata = record(result.metadata ?? result.meta);
  const surface = record(metadata.computerSurface);
  // Neo's own protected-target and per-action consent fences are not OS permissions.
  if (surface.approvalScope === 'blocked' || ['protected app', 'approval required'].includes(String(surface.blockedReason))) return null;
  let blocker: EnvBlockerClass;
  let target: string;
  let pane: 'automation' | 'accessibility' | 'screenCapture';
  if (AUTOMATION_TARGETS[input.toolName] && (result.code ?? metadata.code) === 'not_authorized') {
    blocker = 'perm_automation';
    target = AUTOMATION_TARGETS[input.toolName];
    pane = 'automation';
  } else if (['screenshot', 'computer_use'].includes(input.toolName)) {
    const cause = detectScreenshotFailureCause({
      platform: process.platform, env: process.env,
      message: typeof result.error === 'string' ? result.error : undefined,
      stderr: typeof metadata.stderr === 'string' ? metadata.stderr : undefined,
    });
    // A non-graphical session cannot be repaired by granting capture permission.
    if (cause.kind === 'ssh_session_no_gui' || cause.kind === 'no_display_server') return null;
    if (cause.kind === 'screen_recording_permission' || metadata.failureCause === 'screen_recording_permission') {
      blocker = 'perm_screen_recording'; target = 'screen'; pane = 'screenCapture';
    } else if (process.platform === 'darwin' && input.toolName === 'computer_use' && ['permission_denied', 'ax_unavailable'].includes(String(metadata.failureKind))) {
      blocker = 'perm_accessibility'; target = 'computer'; pane = 'accessibility';
    } else return null;
  } else return null;
  return {
    id: `${input.runId}|${blocker}|${target}`,
    sessionId: input.sessionId, runId: input.runId, class: blocker,
    target: { id: target, labelKey: `env.target.${target}` },
    phase: 'needs_user', sentenceKey: `env.sentence.${target}`,
    action: { kind: 'open_settings_pane', labelKey: `env.allow.${target}`, payload: { pane } },
    resume: { mode: 'manual' }, updatedAt: Date.now(),
  };
}
