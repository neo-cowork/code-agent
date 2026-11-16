// ============================================================================
// AppleScript helpers for native macOS office connectors
// ============================================================================

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../../services/infra/logger';
import { APPLE_EVENTS_PERMISSION_PROMPT_TIMEOUT_MS } from '../../../shared/constants/envAssist';
import { resolveShellBridgeClientFromEnv } from '../../permissions/envAssist/shellBridge/client';
import { createShellPassiveBridge } from '../../permissions/envAssist/probes/shellPassiveBridge';
import { automationProbe } from '../../permissions/envAssist/probes/passiveProbes';
import type { PassiveBridge } from '../../permissions/envAssist/probes/types';

const logger = createLogger('AppleScriptDate', { lane: 'mcp' });

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 1024 * 1024 * 10;
const DEFAULT_TIMEOUT = 15_000;

// Keep existing connector/tool imports on the same shared classifier.
export {
  appleScriptFailureLogDetail,
  describeAppleScriptFailure,
  isAppleEventsDenied,
  isAppleScriptFailure,
  type AppleScriptFailureCode,
} from './appleScriptFailure';

// The shell hands bridge credentials over once per process; build the passive bridge once (null = no desktop shell).
let passiveBridge: PassiveBridge | null | undefined;

/**
 * Whether macOS may still ask the user before a script can control this app. Passive (never prompts):
 * -1744 undecided, or -600 (app not running yet, so the answer is unknown until the script launches it).
 * Without the desktop shell the answer is unknown and the ordinary budget applies.
 */
async function automationAnswerPending(targetBundleId: string): Promise<boolean> {
  passiveBridge ??= ((client) => (client ? createShellPassiveBridge(client) : null))(resolveShellBridgeClientFromEnv());
  const { status } = await automationProbe(passiveBridge, targetBundleId)();
  return status === 'undecided' || status === 'not_running';
}

/**
 * `permissionTarget` (the controlled app's bundle id) opts a connector into the permission-dialog budget: while the
 * automation answer is still pending, the first script shows the system dialog and blocks until the user answers.
 */
export async function runAppleScript(lines: string[], options?: { permissionTarget?: string }): Promise<string> {
  const args = lines.flatMap((line) => ['-e', line]);
  const timeout = options?.permissionTarget && await automationAnswerPending(options.permissionTarget)
    ? APPLE_EVENTS_PERMISSION_PROMPT_TIMEOUT_MS
    : DEFAULT_TIMEOUT;
  const { stdout } = await execFileAsync('osascript', args, {
    timeout,
    maxBuffer: MAX_BUFFER,
  });
  return stdout.trim();
}

export function escapeAppleScriptString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

const ENGLISH_MONTHS: Record<string, number> = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
};

function to24Hour(hour: number, meridiem: string | undefined): number {
  if (!meridiem) return hour;
  if (meridiem === '中午') return hour < 6 ? hour + 12 : hour;
  const pm = /^(PM|下午|晚上)$/i.test(meridiem);
  const h = hour % 12;
  return pm ? h + 12 : h;
}

function localTime(
  year: string, month0: number, day: string,
  hour: string, minute: string, second: string, meridiem?: string,
): number {
  return new Date(
    Number(year), month0, Number(day),
    to24Hour(Number(hour), meridiem), Number(minute), Number(second),
  ).getTime();
}

/**
 * 解析 AppleScript 输出的日期。顺序：ISO（isoDateText 产出，本地时间）→ 英文系统格式
 * → 中文系统格式。空串 = 字段本就缺省，静默 null；非空但解析失败 = warn 带原文再 null。
 */
export function parseAppleScriptDate(value: string): number | null {
  const text = value.trim();
  if (!text) return null;

  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (m) return localTime(m[1], Number(m[2]) - 1, m[3], m[4], m[5], m[6]);

  m = text.match(
    /^(?:[A-Za-z]+,\s+)?([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})(?:\s+at)?\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s*([AP]M))?$/i
  );
  if (m) {
    const month = ENGLISH_MONTHS[m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()];
    if (month !== undefined) return localTime(m[3], month, m[2], m[4], m[5], m[6], m[7]);
  }

  m = text.match(
    /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(?:星期|周)[一二三四五六日天])?\s*(?:(上午|下午|凌晨|早上|中午|晚上)\s*)?(\d{1,2}):(\d{2}):(\d{2})(?:\s*([AP]M))?$/i
  );
  if (m) return localTime(m[1], Number(m[2]) - 1, m[3], m[5], m[6], m[7], m[4] ?? m[8]);

  logger.warn('Unparseable AppleScript date, returning null', { raw: value });
  return null;
}

export function buildAppleScriptDateVar(varName: string, timestampMs: number): string[] {
  const date = new Date(timestampMs);
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  const midnightSeconds =
    (date.getHours() * 60 * 60)
    + (date.getMinutes() * 60)
    + date.getSeconds();

  return [
    `set ${varName} to current date`,
    `set year of ${varName} to ${date.getFullYear()}`,
    `set month of ${varName} to ${monthNames[date.getMonth()]}`,
    `set day of ${varName} to ${date.getDate()}`,
    `set time of ${varName} to ${midnightSeconds}`,
  ];
}

export function sharedAppleScriptHandlers(): string[] {
  return [
    'on sanitizeText(valueText)',
    'if valueText is missing value then return ""',
    'set safeText to valueText as text',
    'set {oldTID, AppleScript\'s text item delimiters} to {AppleScript\'s text item delimiters, {"|", return & linefeed, return, linefeed, tab}}',
    'set textParts to text items of safeText',
    'set AppleScript\'s text item delimiters to " "',
    'set safeText to textParts as text',
    'set AppleScript\'s text item delimiters to oldTID',
    'return safeText',
    'end sanitizeText',
    'on joinLines(lineItems)',
    'set {oldTID, AppleScript\'s text item delimiters} to {AppleScript\'s text item delimiters, linefeed}',
    'set joinedText to lineItems as text',
    'set AppleScript\'s text item delimiters to oldTID',
    'return joinedText',
    'end joinLines',
    'on pad2(n)',
    'return text -2 thru -1 of ("0" & (n as integer))',
    'end pad2',
    'on isoDateText(d)',
    'if d is missing value then return ""',
    'set y to (year of d) as integer',
    'set yText to text -4 thru -1 of ("000" & y)',
    'return yText & "-" & my pad2((month of d) as integer) & "-" & my pad2(day of d) & "T" & my pad2(hours of d) & ":" & my pad2(minutes of d) & ":" & my pad2(seconds of d)',
    'end isoDateText',
  ];
}
