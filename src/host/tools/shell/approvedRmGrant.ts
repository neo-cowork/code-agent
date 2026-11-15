import path from 'node:path';
import { parseShellCommand } from '../../security/commandParse';
import type { PolicyEnforcer } from '../../security/policyEnforcer';
import type { PermissionRequestData, ToolContext } from '../types';
import { getPermissionModeManager } from '../../permissions/modes';
import { resolveEffectiveSessionMode } from '../../permissions/runPolicySnapshot';
import { getSandboxManager } from '../../sandbox';
import type { OsSandboxPermissionMode } from '../../sandbox/osSandboxPolicy';
import { isBashToolName } from '../toolNames';
import { approvedSingleFileRmGrant } from './sandboxEscalation';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ApprovedRmGrant');

interface ApprovedRmToolApprovalInput {
  approvalSource?: string;
  toolName: string;
  params: Record<string, unknown>;
  permissionRequest: PermissionRequestData;
  sessionId?: string;
  context: Pick<ToolContext, 'requiresOsWriteFence'>;
  abortSignal?: AbortSignal;
  workingDirectory: string;
  policyEnforcer?: PolicyEnforcer | null;
}

/** Turn one user-approved plain rm call into a one-call literal-file seatbelt grant. */
export function approvedSingleFileRmGrantForToolApproval(
  input: ApprovedRmToolApprovalInput,
): string | string[] | undefined {
  if (!isBashToolName(input.toolName)) return undefined;
  const command = input.params.command;
  if (typeof command !== 'string' || !parseShellCommand(command).segments.some(
    segment => path.posix.basename(segment.words[0] ?? '') === 'rm',
  )) return undefined;
  if (input.approvalSource !== 'user') {
    logger.warn('APPROVED_RM_GRANT_REFUSED {"conditions":["approval_source"]}');
    return undefined;
  }
  return approvedSingleFileRmGrant(command, {
    sandboxDecision: {
      sandboxed: (input.permissionRequest.details.sandbox as { applied?: unknown } | undefined)?.applied === true,
    },
    foreground: input.params.pty !== true && input.params.run_in_background !== true,
    pty: input.params.pty === true,
    background: input.params.run_in_background === true,
    unattended: getPermissionModeManager().isUnattendedSession(input.sessionId),
    writeFence: input.context.requiresOsWriteFence === true,
    evalRealRoot: process.env.CODE_AGENT_EVAL_REAL_ROOT !== undefined,
    permissionMode: resolveEffectiveSessionMode(input.sessionId) as OsSandboxPermissionMode,
    abortSignal: input.abortSignal ?? new AbortController().signal,
    newFileGrantSupported: getSandboxManager().supportsNewFileWriteGrant(),
    workingDirectory: input.workingDirectory,
    policyEnforcer: input.policyEnforcer,
  });
}
