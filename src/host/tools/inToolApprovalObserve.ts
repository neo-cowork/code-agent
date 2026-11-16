// An approval card raised from inside a tool body (e.g. Bash sandbox widening) must land in the
// same goal-sticky table as the top-level ask, otherwise a user denial there is never recorded and
// the next same-message ask raises a fresh card.
import { getDenialRegistry } from '../security/denialRegistry';
import type { PermissionAskResult, PermissionDenialSource } from '../../shared/contract/permission';
import type { PermissionRequestData } from './types';

export function observeInToolApproval(input: {
  sessionId?: string; sourceMessageId?: string; runId?: string;
  request: PermissionRequestData;
  ask: () => Promise<PermissionAskResult & { denialSource: PermissionDenialSource | undefined }>;
}): Promise<PermissionAskResult & { denialSource: PermissionDenialSource | undefined }> {
  return getDenialRegistry().observeApproval({
    sessionId: input.sessionId, sourceMessageId: input.sourceMessageId, runId: input.runId,
    toolName: input.request.tool, enabled: !input.request.details?.sensitiveStep,
    ask: input.ask,
  });
}
