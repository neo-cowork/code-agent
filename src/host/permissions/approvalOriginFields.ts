import type { ToolApprovalPayload } from '../../shared/contract/pendingApproval';

type ApprovalOriginFields = Pick<ToolApprovalPayload, 'startedByAutomation' | 'scheduledTaskName' | 'userRequest'>;

/** Copy only the host-owned origin fields (scheduled-task flag/name, user quote) that are present. */
export function pickApprovalOrigin(source: ApprovalOriginFields | undefined): ApprovalOriginFields {
  const out: ApprovalOriginFields = {};
  if (source?.startedByAutomation === true) out.startedByAutomation = true;
  if (source?.scheduledTaskName) out.scheduledTaskName = source.scheduledTaskName;
  if (source?.userRequest) out.userRequest = source.userRequest;
  return out;
}
