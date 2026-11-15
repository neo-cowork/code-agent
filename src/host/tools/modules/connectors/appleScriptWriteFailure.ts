import type { Logger } from '../../../protocol/tools';
import {
  appleScriptFailureLogDetail,
  describeAppleScriptFailure,
  isAppleScriptFailure,
} from '../../../connectors/native/osascript';
import { isCalendarFailure } from '../../../connectors/native/calendar';

const NO_BASH_GUIDANCE =
  'Do not work around this by running osascript or AppleScript through Bash or any script; tell the user what failed.';

export function describeAppleScriptWriteFailure(
  connectorLabel: string,
  failurePrefix: string,
  error: unknown,
  logger: Logger,
  toolName: string,
): string {
  if (isAppleScriptFailure(error)) {
    const described = describeAppleScriptFailure(connectorLabel, error, { timeoutContext: 'write' });
    logger.warn(`${toolName} osascript failed`, {
      connector: connectorLabel.toLowerCase(),
      code: described.code,
      detail: appleScriptFailureLogDetail(error),
    });
    return `${described.message} ${NO_BASH_GUIDANCE}`;
  }

  return `${failurePrefix}: ${error instanceof Error ? error.message : String(error)}`;
}

/** Calendar writes go through EventKit (no osascript); the failure keeps its machine code for the permission card. */
export function describeCalendarWriteFailure(failurePrefix: string, error: unknown, logger: Logger, toolName: string): string {
  if (isCalendarFailure(error)) {
    logger.warn(`${toolName} failed`, { connector: 'calendar', code: error.code });
    return error.message;
  }
  return `${failurePrefix}: ${error instanceof Error ? error.message : String(error)}`;
}

export function calendarFailureCode(error: unknown): { code?: string } {
  return isCalendarFailure(error) ? { code: error.code } : {};
}
