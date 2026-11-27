import path from 'node:path';
import type { Message, ToolCall, ToolResult } from '../../../../shared/contract';
import { extractApprovedRmTargets } from '../../shell/sandboxEscalation';
import { isBashToolName } from '../../toolNames';
import { recordApprovedRmSettlementTargets } from '../../../session/approvedRmSettlementTargets';

/** rm's own options never change which paths it names, and the approval parser admits only -f/-v. */
const RM_OPTION_WORDS = /(^|[\s;&|(])((?:\/usr)?(?:\/bin\/)?rm)((?:[ \t]+-[A-Za-z]+)+)(?=[ \t])/g;

/**
 * Called when a tool call of the run ends. A Bash rm whose literal file operands are still on disk
 * did not delete them, whatever the run reports later: refused before any approval, denied, blocked
 * by the sandbox, or failed behind a trailing `; echo "exit=$?"`. Those files join the run's
 * settlement record, so the settle-time check judges the task by what is on disk. A call handed to a
 * background task never ends here: it is sealed as a tool message without a tool_call_end.
 */
export function recordUnfinishedRmSettlementTargets(
  sessionId: string,
  runId: string | undefined,
  history: readonly Pick<Message, 'toolCalls'>[],
  result: ToolResult,
  runCwd: string,
): void {
  const isCall = (candidate: ToolCall) => candidate.id === result.toolCallId;
  const call = history.findLast((message) => message.toolCalls?.some(isCall))?.toolCalls?.find(isCall);
  const command = call?.arguments.command;
  if (!call || !isBashToolName(call.name) || typeof command !== 'string' || !/\brm\b/.test(command)) return;
  const workdir = call.arguments.working_directory;
  const cwd = typeof workdir === 'string' && workdir.trim() ? path.resolve(runCwd, workdir) : runCwd;
  const { targets } = extractApprovedRmTargets(command.replace(RM_OPTION_WORDS, '$1$2'), cwd);
  if (targets?.length) recordApprovedRmSettlementTargets(sessionId, runId, targets, 'unfinished_rm');
}
