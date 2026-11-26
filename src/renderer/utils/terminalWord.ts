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

type FinishedToolStep = { id?: string; name?: string; arguments?: unknown; success?: boolean };

/** Ledger task fields the delegation matching reads (a structural subset of the background `Task`). */
export type DelegationLedgerTask = {
  toolCallId?: string;
  status: string;
  progress?: { lastToolFailure?: unknown; failedToolCalls?: number };
};

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

/** Same file: equal paths, or one is a segment-aligned suffix of the other (a.pdf vs /ws/a.pdf; not src/a/x.ts vs src/b/x.ts). */
function sameTarget(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

// A delegation can only vouch for a concrete file: the last segment needs an extension (not a URL route like /status).
const FILE_LIKE_TARGET = /^(?![a-z][a-z0-9+.-]+:\/)(?:.*\/)?[^/]+\.[A-Za-z0-9]{1,8}$/i;
const PATH_STOP = /[\s"'`<>()（）「」《》，。、：；,;]/;

/** Does the delegation prompt name this failed target (file name or path, same-file rules as `sameTarget`)? */
function promptNamesTarget(prompt: string, target: string): boolean {
  const text = prompt.replace(/\\/g, '/');
  const base = target.slice(target.lastIndexOf('/') + 1);
  if (!base) return false;
  for (let at = text.indexOf(base); at !== -1; at = text.indexOf(base, at + 1)) {
    const before = text[at - 1] ?? '';
    const after = text[at + base.length] ?? '';
    const afterNext = text[at + base.length + 1] ?? '';
    if (/[A-Za-z0-9_-]/.test(after) || (after === '.' && /[A-Za-z0-9_]/.test(afterNext))) continue;
    let start = at;
    if (before === '/') {
      while (start > 0 && !PATH_STOP.test(text[start - 1])) start -= 1;
    } else if (/[\p{L}\p{N}_.-]/u.test(before)) {
      continue; // `备份合同.pdf` must not name `合同.pdf`
    }
    const candidate = text.slice(start, at + base.length).replace(/^\.\//, '');
    if (sameTarget(candidate, target)) return true;
  }
  return false;
}

/** A completed, failure-free ledger task for this delegate_task call: the only thing that can stand in for a retry. */
function completedDelegationPrompt(step: FinishedToolStep, tasks: readonly DelegationLedgerTask[]): string | null {
  if (step.name !== 'delegate_task' || step.success === false || !step.id) return null;
  const prompt = (step.arguments as { prompt?: unknown } | null | undefined)?.prompt;
  if (typeof prompt !== 'string' || !prompt) return null;
  const done = tasks.some((task) =>
    task.toolCallId === step.id && task.status === 'completed'
    && !task.progress?.lastToolFailure && !task.progress?.failedToolCalls);
  return done ? prompt : null;
}

/**
 * Finished steps in call order; only failures without a later matching success remain.
 * `tasks` (ledger) lets a later completed `delegate_task` whose prompt names every failed file recover that failure.
 */
export function classifyToolSteps(
  steps: readonly FinishedToolStep[],
  tasks: readonly DelegationLedgerTask[] = [],
): ToolStepOutcome | undefined {
  if (!steps.length) return undefined;
  const successfulTargets = new Set<string>();
  // Untargeted steps (npm test, List): only an identical later call (same tool + same arguments) is a retry.
  const successfulUntargetedCalls = new Set<string>();
  const delegatedPrompts: string[] = [];
  const callKey = (step: FinishedToolStep) => `${step.name}\u0000${JSON.stringify(step.arguments ?? null)}`;
  let failed = 0;
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    const targets = targetTokens(step.arguments);
    if (step.success !== false) {
      const delegated = completedDelegationPrompt(step, tasks);
      if (delegated) delegatedPrompts.push(delegated);
      for (const target of targets) successfulTargets.add(target);
      if (!targets.size && step.name) successfulUntargetedCalls.add(callKey(step));
    } else {
      const recovered = targets.size
        ? [...targets].some((target) => [...successfulTargets].some((done) => sameTarget(target, done)))
        : Boolean(step.name && successfulUntargetedCalls.has(callKey(step)));
      const files = [...targets].filter((target) => FILE_LIKE_TARGET.test(target));
      const delegatedRecovery = !recovered && files.length > 0
        && files.every((file) => delegatedPrompts.some((prompt) => promptNamesTarget(prompt, file)));
      if (!recovered && !delegatedRecovery) failed += 1;
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
