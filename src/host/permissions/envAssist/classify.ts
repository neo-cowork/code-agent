import type { EnvAssistNotice, EnvBlockerClass } from '../../../shared/contract/envAssist';
import { classifyCuaFailure } from '../../mcp/cuaFailureStats';
import { parseCuaToolName } from '../cuaAppTarget';
import type { CuaHelperPermissionState } from './cua/helperPermissionState';
import { detectScreenshotFailureCause } from './screenshotFailureCause';

const AUTOMATION_TARGETS: Readonly<Record<string, string>> = {
  mail: 'mail', reminders: 'reminders', reminders_create: 'reminders',
};
/** Calendar reads and writes go through EventKit: one permission (perm_calendars), not Apple events. */
const CALENDAR_TOOLS = new Set(['calendar', 'calendar_create_event', 'calendar_update_event', 'calendar_delete_event']);

/** A failed MCP result keeps the driver's text in `output`; `error` is only the generic backfill from ensureFailedToolResultError. */
export function cuaFailureText(result: { error?: unknown; output?: unknown }): string {
  return [result.error, result.output].filter((part): part is string => typeof part === 'string').join('\n');
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Which pane a denied cua call needs: the helper's own state wins, the error text is the fallback. */
function cuaPane(errorText: string, state: CuaHelperPermissionState | undefined): 'screenCapture' | 'accessibility' | null {
  const hint = /screen[ _-]?(?:recording|capture)/i.test(errorText) ? 'screenCapture'
    : /accessibility/i.test(errorText) ? 'accessibility' : null;
  if (state?.status !== 'known') return hint;
  const denied = [state.screenRecording === false && 'screenCapture', state.accessibility === false && 'accessibility']
    .filter((pane): pane is 'screenCapture' | 'accessibility' => pane !== false);
  return hint && denied.includes(hint) ? hint : denied[0] ?? null;
}

/** Only S1's three permission classes are actionable; other failures remain with their owners. */
export function classifyEnvBlocker(input: {
  toolName: string; result: unknown; sessionId: string; runId: string;
  /** Helper-identity state for mcp__cua-driver__* denials; absent when the probe was unavailable. */
  cuaPermissions?: CuaHelperPermissionState;
}): EnvAssistNotice | null {
  const result = record(input.result);
  if (result.success !== false && result.ok !== false) return null;
  const metadata = record(result.metadata ?? result.meta);
  const surface = record(metadata.computerSurface);
  // Neo's own protected-target and per-action consent fences are not OS permissions.
  if (surface.approvalScope === 'blocked' || ['protected app', 'approval required'].includes(String(surface.blockedReason))) return null;
  let blocker: EnvBlockerClass;
  let target: string;
  let pane: 'automation' | 'calendars' | 'accessibility' | 'screenCapture';
  if (CALENDAR_TOOLS.has(input.toolName) && (result.code ?? metadata.code) === 'not_authorized') {
    blocker = 'perm_calendars';
    target = 'calendar';
    pane = 'calendars';
  } else if (AUTOMATION_TARGETS[input.toolName] && (result.code ?? metadata.code) === 'not_authorized') {
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
  } else if (parseCuaToolName(input.toolName) !== null && classifyCuaFailure(cuaFailureText(result)) === 'permission') {
    const cuaTarget = cuaPane(cuaFailureText(result), input.cuaPermissions);
    if (!cuaTarget) return null;
    const screen = cuaTarget === 'screenCapture';
    blocker = screen ? 'perm_screen_recording' : 'perm_accessibility';
    target = screen ? 'helperScreen' : 'helperComputer';
    pane = cuaTarget;
    return {
      id: `${input.runId}|${blocker}|${target}`,
      sessionId: input.sessionId, runId: input.runId, class: blocker,
      target: { id: target, labelKey: `env.target.${target}` },
      phase: 'needs_user', sentenceKey: `env.sentence.${target}`,
      action: { kind: 'request_grant', labelKey: `env.allow.${target}`, payload: { pane } },
      resume: { mode: 'manual' }, updatedAt: Date.now(),
    };
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
