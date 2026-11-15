import type { StreamInterruptionReason, ToolCall } from '@shared/contract';
import type { Translations } from '../i18n';
import { resolveStreamInterruptionOutcomeKey } from '../i18n/outcomeWords';
import { humanizeToolStep } from './humanizeToolStep';
import { isToolInterruptionPlaceholder } from './toolExecutionPresentation';
import {
  getStreamInterruptionReasonLabel,
  humanizeInterruptedToolAction,
} from './streamInterruptionPresentation';

/**
 * The four contradictory status-line words from FB-114, as mutually exclusive
 * terminals. Other outcome phrases (已取消 / 切换会话时中断) are still one
 * terminal; they just are not this four-word set.
 */
type ToolStatusLineTerminal =
  | 'interrupted'
  | 'failed'
  | 'not-executed'
  | 'restart-interrupted'
  /** 环境授权停车：在等用户允许，不是中断。 */
  | 'env-waiting';

interface ToolStatusLineFlags {
  /** Would have emitted 已中断 (status === interrupted). */
  interrupted: boolean;
  /** Would have emitted 未成功 (failed humanize / error result). */
  failed: boolean;
  /** Would have emitted 未执行 (interrupted extra span). */
  notExecuted: boolean;
  /** Would have emitted 应用重启时中断 (app-restart reason span). */
  restartInterrupted: boolean;
}

// 只在本文件内部用，别导出——导出无人消费的类型会打红 knip dead-export 棘轮。
type ToolStatusLineStatus = 'pending' | 'success' | 'error' | 'interrupted';

export interface ToolStatusLineInput {
  status: ToolStatusLineStatus;
  interruptionReason?: StreamInterruptionReason;
  toolCall: Pick<ToolCall, 'name' | 'arguments' | 'shortDescription' | 'stepLabel' | 'result'>;
  awaitingApproval?: boolean;
  /**
   * 这一步停在等环境授权上（env_blocked 停车）：人话授权目标（「日历」）。不是中断——
   * 终态说在等什么，连接器名只在这里出现一次，动作不再带连接器前缀。
   */
  envWaitingTarget?: string;
}

export interface ToolStatusLineCopy {
  terminalKey: ToolStatusLineTerminal;
  terminal: string;
  action: string;
  line: string;
}

const RAW_NO_MATCHES = /^(?:No matches(?: found)?|0 matches|No files matched the pattern)$/i;

export function isRawToolStdoutNoMatches(summary: string): boolean {
  return RAW_NO_MATCHES.test(summary.trim());
}

function deriveToolStatusLineFlags(input: ToolStatusLineInput): ToolStatusLineFlags {
  const interrupted = input.status === 'interrupted';
  const placeholder = isToolInterruptionPlaceholder(input.toolCall.result?.error);
  const failed = input.status === 'error'
    || (input.toolCall.result?.success === false && !placeholder);
  const notExecuted = interrupted && (input.toolCall.result === undefined || placeholder);
  const restartInterrupted = interrupted && input.interruptionReason === 'app-restart';
  return { interrupted, failed, notExecuted, restartInterrupted };
}

/**
 * One terminal wins. Restart is the cause; generic interrupt beats a leftover
 * failure verb; "not executed" only wins when it is not already an interrupt;
 * failure is last.
 */
function resolveToolStatusLineTerminal(
  flags: ToolStatusLineFlags,
): Exclude<ToolStatusLineTerminal, 'env-waiting'> {
  if (flags.restartInterrupted) return 'restart-interrupted';
  if (flags.interrupted) return 'interrupted';
  if (flags.notExecuted) return 'not-executed';
  return 'failed';
}

function formatToolStatusLineTerminal(
  terminal: Exclude<ToolStatusLineTerminal, 'env-waiting'>,
  t: Translations,
  interruptionReason?: StreamInterruptionReason,
): string {
  switch (terminal) {
    case 'restart-interrupted':
      return getStreamInterruptionReasonLabel('app-restart', t);
    case 'interrupted': {
      if (interruptionReason && interruptionReason !== 'user') {
        return getStreamInterruptionReasonLabel(interruptionReason, t);
      }
      return t.outcomeWords[
        resolveStreamInterruptionOutcomeKey(interruptionReason)
      ].timeline.label;
    }
    case 'not-executed':
      return t.toolStatus.notExecuted;
    case 'failed':
      return failedTerminalWord(t);
  }
}

function failedTerminalWord(t: Translations): string {
  const wrap = t.toolStepHumanize.intentWrap.failed;
  const placeholder = '{action}';
  const idx = wrap.indexOf(placeholder);
  if (idx === 0) {
    const suffix = wrap.slice(placeholder.length).trim();
    if (suffix) return suffix;
  }
  return t.outcomeWords['failed-tool'].badge.label;
}

export function buildToolStatusLineCopy(
  input: ToolStatusLineInput,
  t: Translations,
): ToolStatusLineCopy {
  if (input.status === 'interrupted' && input.envWaitingTarget) {
    const terminal = t.durableStopped.envWaitingStep.replace('{target}', input.envWaitingTarget);
    const action = humanizeInterruptedToolAction(input.toolCall, t, { connectorPrefixRendered: true });
    return { terminalKey: 'env-waiting', terminal, action, line: `${terminal} · ${action}` };
  }
  const flags = deriveToolStatusLineFlags(input);
  const terminalKey = resolveToolStatusLineTerminal(flags);
  const terminal = formatToolStatusLineTerminal(terminalKey, t, input.interruptionReason);
  const action = input.status === 'interrupted' || flags.notExecuted
    ? humanizeInterruptedToolAction(input.toolCall, t)
    : humanizeToolStep(
        input.toolCall.name,
        input.toolCall.arguments as Record<string, unknown> | undefined,
        t,
        input.toolCall.shortDescription,
        input.awaitingApproval
          ? 'pending-approval'
          : input.status === 'pending'
            ? 'running'
            : input.status === 'error'
              ? 'failed'
              : 'completed',
        input.toolCall.stepLabel,
      );
  const line = input.status === 'interrupted'
    ? `${terminal} · ${action}`
    : action;
  return { terminalKey, terminal, action, line };
}
