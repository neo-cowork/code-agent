// ============================================================================
// 终态词唯一解析器：任务面板 / 后台任务行 / 自动化中心都读这里，再去
// i18n/outcomeWords 取词。各面板不再各自从 status 推一套「已完成/已停止/失败」。
// ============================================================================

import { resolveRunCancellationOutcomeKey, type OutcomeKey } from '../i18n/outcomeWords';
import type { RunUiState } from '../types/runWorkbench';
import { BACKGROUND_TASK_CANCELLED } from '@shared/constants';
import type { BackgroundSessionInfo } from '@shared/contract/sessionState';

/** 「已完成」是否被失败步骤推翻：全败 → failed-tool，部分败 → completed-with-warnings。前台 run 与后台行共用。 */
function resolveCompletedKey(steps: ToolStepOutcome | undefined): OutcomeKey {
  if (!steps || steps.failed === 0) return 'completed';
  return steps.failed >= steps.total ? 'failed-tool' : 'completed-with-warnings';
}

type ToolStepOutcome = NonNullable<RunUiState['toolStepOutcome']>;

type FinishedToolStep = { name?: string; arguments?: unknown; success?: boolean };

function targetTokens(args: unknown): Set<string> {
  const targets = new Set<string>();
  const add = (raw: string) => {
    const value = raw.trim().replace(/\\/g, '/');
    if (!value) return;
    const parts: string[] = [];
    for (const part of value.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
      else parts.push(part);
    }
    if (!parts.length) return;
    targets.add(parts.join('/'));
    targets.add(parts.at(-1)!);
  };
  const visit = (value: unknown, key = '') => {
    if (typeof value === 'string') {
      if (/^(file_?path|path|url|pattern)$/i.test(key)) add(value);
      if (key === 'command') {
        // Keep quoted paths with spaces; also inspect filenames inside quoted scripts.
        const scan = (command: string) => {
          for (const match of command.matchAll(/"([^"\n]*)"|'([^'\n]*)'|[^\s|&;<>()[\]`'"=]+/g)) {
            const token = match[1] ?? match[2] ?? match[0];
            if (/["']/.test(token)) scan(token);
            else if (token.includes('/') || /\.[\p{L}\p{N}]+$/u.test(token)) add(token);
          }
        };
        // Shared non-file tokens must not link steps: working dirs (cd/pushd), redirection sinks, /dev/*.
        scan(value
          .replace(/\b(?:cd|pushd)\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)/g, ' ')
          .replace(/\d*[<>]{1,2}&?\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)/g, ' ')
          .replace(/\/dev\/\w+/g, ' '));
      }
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
    } else if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  visit(args);
  return targets;
}

/** Finished steps in call order; only failures without a later matching success remain. */
export function classifyToolSteps(steps: readonly FinishedToolStep[]): ToolStepOutcome | undefined {
  if (!steps.length) return undefined;
  const successfulTargets = new Set<string>();
  const successfulUntargetedTools = new Set<string>();
  let failed = 0;
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    const targets = targetTokens(step.arguments);
    if (step.success !== false) {
      for (const target of targets) successfulTargets.add(target);
      if (!targets.size && step.name) successfulUntargetedTools.add(step.name);
    } else {
      const recovered = targets.size
        ? [...targets].some((target) => successfulTargets.has(target))
        : Boolean(step.name && successfulUntargetedTools.has(step.name));
      if (!recovered) failed += 1;
    }
  }
  return { failed, total: steps.length };
}

/** Join stored results to call arguments by id, preserving call order and deduplicating results. */
export function countToolSteps(
  messages: ReadonlyArray<{
    toolCalls?: ReadonlyArray<{
      id?: string; name?: string; arguments?: unknown; _streaming?: boolean;
      result?: { success?: boolean };
    }>;
    toolResults?: ReadonlyArray<{ toolCallId?: string; success?: boolean }>;
  }>,
): ToolStepOutcome | undefined {
  const calls = new Map<string | symbol, FinishedToolStep & { finished?: boolean; streaming?: boolean }>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      const id = call.id ?? Symbol();
      const previous = calls.get(id);
      calls.set(id, {
        ...previous, name: call.name, arguments: call.arguments, streaming: call._streaming,
        ...(call.result ? { finished: true, success: call.result.success } : {}),
      });
    }
    for (const result of message.toolResults ?? []) {
      const id = result.toolCallId ?? Symbol();
      calls.set(id, { ...calls.get(id), finished: true, success: result.success });
    }
  }
  return classifyToolSteps([...calls.values()].filter((call) => call.finished && !call.streaming));
}

/** 前台 run → 终态词键；活跃/等确认返回 null（没有终态可说），干净完成返回 'completed'。 */
export function resolveRunTerminalKey(
  run: Pick<RunUiState, 'status' | 'terminalReason' | 'toolStepOutcome'>,
): OutcomeKey | null {
  switch (run.status) {
    case 'cancelled':
      return resolveRunCancellationOutcomeKey(run.terminalReason);
    case 'blocked':
      return 'failed-unknown';
    case 'completed':
      return resolveCompletedKey(run.toolStepOutcome);
    default:
      return null;
  }
}

/** 后台任务行 → 终态词键；running 返回 null。前台会话已被停掉时（taskCancelled）以停止为准。 */
export function resolveBackgroundTerminalKey(
  session: Pick<BackgroundSessionInfo, 'status' | 'completionMessage'>,
  opts: { taskCancelled?: boolean; toolStepOutcome?: ToolStepOutcome } = {},
): OutcomeKey | null {
  const taskCancelled = opts.taskCancelled ?? false;
  if (session.completionMessage === BACKGROUND_TASK_CANCELLED || (taskCancelled && session.status === 'running')) {
    return 'cancelled-by-user';
  }
  if (session.status === 'failed') return 'failed-unknown';
  if (session.status === 'completed') return resolveCompletedKey(opts.toolStepOutcome);
  return null;
}
