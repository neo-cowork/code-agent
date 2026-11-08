import type { Logger } from '../../../protocol/tools';
import {
  appleScriptFailureLogDetail,
  describeAppleScriptFailure,
  isAppleScriptFailure,
} from '../../../connectors/native/osascript';

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
    const described = describeAppleScriptFailure(connectorLabel, error);
    logger.warn(`${toolName} osascript failed`, {
      connector: connectorLabel.toLowerCase(),
      code: described.code,
      detail: appleScriptFailureLogDetail(error),
    });
    return `${described.message} ${NO_BASH_GUIDANCE}`;
  }

  return `${failurePrefix}: ${error instanceof Error ? error.message : String(error)}`;
}
