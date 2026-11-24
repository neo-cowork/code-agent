import type { ToolApprovalPayload } from '../../shared/contract/pendingApproval';

type ApprovalOriginFields = Pick<ToolApprovalPayload, 'startedByAutomation' | 'startedByFirstWake' | 'scheduledTaskName' | 'userRequest'>;

/** Copy only the host-owned origin and user quote fields that are present. */
export function pickApprovalOrigin(source: ApprovalOriginFields | undefined): ApprovalOriginFields {
  const out: ApprovalOriginFields = {};
  if (source?.startedByAutomation === true) out.startedByAutomation = true;
  if (source?.startedByFirstWake === true) out.startedByFirstWake = true;
  if (source?.scheduledTaskName) out.scheduledTaskName = source.scheduledTaskName;
  if (source?.userRequest) out.userRequest = source.userRequest;
  return out;
}
