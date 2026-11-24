import type { getHostConnectorCopy } from '../../../../shared/i18n/hostConnectorCopy';
import type { Logger } from '../../../protocol/tools';
import {
  appleScriptFailureLogDetail,
  describeAppleScriptFailure,
  isAppleScriptFailure,
} from '../../../connectors/native/osascript';
import { isAppleEventsDenied } from '../../../connectors/native/appleScriptFailure';
import { isCalendarFailure } from '../../../connectors/native/calendar';

const NO_BASH_GUIDANCE =
  'Do not work around this by running osascript or AppleScript through Bash or any script; tell the user what failed.';

export function describeAppleScriptWriteFailure(
  connectorLabel: string,
  failurePrefix: string,
  error: unknown,
  logger: Logger,
  toolName: string,
  includeDetail = true,
): string {
  if (isAppleScriptFailure(error)) {
    const described = describeAppleScriptFailure(connectorLabel, error, { timeoutContext: 'write' });
    logger.warn(`${toolName} osascript failed`, {
      connector: connectorLabel.toLowerCase(),
      code: described.code,
      ...(includeDetail ? { detail: appleScriptFailureLogDetail(error) } : {}),
    });
    return `${described.message} ${NO_BASH_GUIDANCE}`;
  }

  return includeDetail ? `${failurePrefix}: ${error instanceof Error ? error.message : String(error)}` : failurePrefix;
}

/** Calendar writes go through EventKit (no Apple-events script); the failure keeps its machine code for the permission card. */
export function describeCalendarWriteFailure(failurePrefix: string, error: unknown, logger: Logger, toolName: string): string {
  if (isCalendarFailure(error)) {
    logger.warn(`${toolName} failed`, { connector: 'calendar', code: error.code });
    return error.message;
  }
  return `${failurePrefix}: ${error instanceof Error ? error.message : String(error)}`;
}

export function describeCalendarFailureForUser(
  copy: ReturnType<typeof getHostConnectorCopy>['calendar'],
  error: unknown,
): string {
  return copy.failureDetails[isCalendarFailure(error) ? error.code : 'read_failed'];
}

export function calendarFailureCode(error: unknown): { code?: string } {
  return isCalendarFailure(error) ? { code: error.code } : {};
}

/**
 * Machine code of a refused AppleScript write; only `not_authorized` is surfaced (it drives the permission card / park, and
 * the resume text then states nothing was saved). Read from the script runner's own stderr only: `error.message` embeds the script
 * (the draft body), and a timed-out/killed run may already have saved, so neither may be classified as a refusal.
 */
export function appleScriptWriteFailureCode(error: unknown): { code?: 'not_authorized' } {
  if (!isAppleScriptFailure(error)) return {};
  const { stderr, killed, signal } = error as { stderr?: unknown; killed?: unknown; signal?: unknown };
  if (killed === true || (typeof signal === 'string' && signal !== '')) return {};
  return typeof stderr === 'string' && isAppleEventsDenied(stderr) ? { code: 'not_authorized' } : {};
}
