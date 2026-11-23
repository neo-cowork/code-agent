import { homedir } from 'node:os';
import type { EnvAssistNotice, EnvBlockerClass } from '../../../shared/contract/envAssist';
import { classifyCuaFailure } from '../../mcp/cuaFailureStats';
// The task requires reusing the exact proof bash.ts uses for sandbox write denials; no modules/ wrapper exports it.
// eslint-disable-next-line no-restricted-imports
import { sandboxDeniedWritePath } from '../../tools/shell/sandboxFailureDiagnostics';
import { parseCuaToolName } from '../cuaAppTarget';
import type { CuaHelperPermissionState } from './cua/helperPermissionState';
import { detectScreenshotFailureCause } from './screenshotFailureCause';

const AUTOMATION_TARGETS: Readonly<Record<string, string>> = {
  // Reminders reads route authorization failures through the connector's Check action.
  mail: 'mail', mail_draft: 'mail', reminders_create: 'reminders',
};
/** Calendar reads and writes go through EventKit: one permission (perm_calendars), not Apple events. */
const CALENDAR_TOOLS = new Set(['calendar', 'calendar_create_event', 'calendar_update_event', 'calendar_delete_event']);

const FILE_READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'ListDirectory']);
const READ_ONLY_COMMANDS = 'ls|cat|head|tail|stat|du|wc|file|find|grep|tree|less|more|cd';
const OS_DENIAL = /\bEPERM\b|Operation not permitted/i;

/** macOS asks per app before Desktop/Documents/Downloads open; a refused answer shows up as a bare EPERM. */
function isFilesAndFoldersDenial(toolName: string, result: Record<string, unknown>, metadata: Record<string, unknown>): boolean {
  if (process.platform !== 'darwin') return false;
  const text = cuaFailureText(result);
  if (!OS_DENIAL.test(text)) return false;
  const home = homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const folder = `(?:~|${home})/(?:Desktop|Documents|Downloads)(?=$|[/\\s'":,)])`;
  const protectedPath = new RegExp(`(?:^|[\\s'"(=:])${folder}`);
  if (!protectedPath.test(text)) return false;
  if (FILE_READ_TOOLS.has(toolName)) return (result.code ?? metadata.code) === 'FS_ERROR';
  if (toolName !== 'Bash') return false;
  // A proven sandbox write denial belongs to the widen-sandbox card, not to macOS privacy settings.
  if (sandboxDeniedWritePath(text) !== undefined) return false;
  // Neo's own seatbelt also refuses every write outside the workspace with the same generic text, so absence of a write
  // proof is not enough: the failing command itself must be a read-only one (`ls: <path>: Operation not permitted`).
  const readOnlyLine = new RegExp(`^\\s*(?:-?bash: (?:line \\d+: )?)?(?:${READ_ONLY_COMMANDS}): ${folder}[^\\n]*(?:Operation not permitted|EPERM)`, 'im');
  return readOnlyLine.test(text);
}

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
  let pane: 'automation' | 'calendars' | 'accessibility' | 'screenCapture' | 'filesAndFolders';
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
  } else if (isFilesAndFoldersDenial(input.toolName, result, metadata)) {
    blocker = 'perm_files';
    target = 'files';
    pane = 'filesAndFolders';
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
