// result.json 的形状与失败文案。run.ts 用它写结果，单测通过同一入口校验——不另造替身。
export interface FailedStep {
  n: number;
  text: string;
}

export interface AttemptResult {
  n: number;
  status: 'pass' | 'fail' | 'skip';
  failedStep: FailedStep | null;
  durationMs: number;
  screenshot: string | null;
  sse: string | null;
  db: string | null;
  /** 已知的模型分支原因（模型没走任务书点名的那条路等）；没有就是空串。 */
  reason: string;
}

export interface FlowResult {
  id: string;
  title: string;
  attempts: AttemptResult[];
  /** 全部尝试都 pass，且次数达到 stableAttempts。 */
  stable: boolean;
}

export interface CoreResult {
  schema: 1;
  startedAt: string;
  commit: string;
  model: string;
  flows: FlowResult[];
  summary: { pass: number; fail: number; skip: number; stable3: number };
}

export const STABLE_ATTEMPTS = 3;

export interface AttemptInput {
  n: number;
  /** 基础设施中断（浏览器被关/崩溃）：没有评估这条流程，记为 skip。 */
  infra?: boolean;
  failedStep: FailedStep | null;
  durationMs: number;
  screenshot: string | null;
  sse: string | null;
  db: string | null;
  reason: string;
}

/** 状态由 failedStep 决定：有失败步骤就是 fail，没有就是 pass。 */
export function buildAttempt(input: AttemptInput): AttemptResult {
  return {
    n: input.n,
    status: input.infra ? 'skip' : input.failedStep ? 'fail' : 'pass',
    failedStep: input.failedStep ? { n: input.failedStep.n, text: input.failedStep.text } : null,
    durationMs: input.durationMs,
    screenshot: input.screenshot,
    sse: input.sse,
    db: input.db,
    reason: input.reason,
  };
}

export function buildFlowResult(id: string, title: string, attempts: AttemptResult[]): FlowResult {
  const stable = attempts.length >= STABLE_ATTEMPTS && attempts.every((a) => a.status === 'pass');
  return { id, title, attempts, stable };
}

export function buildResult(meta: { startedAt: string; commit: string; model: string }, flows: FlowResult[]): CoreResult {
  const all = flows.flatMap((f) => f.attempts);
  return {
    schema: 1,
    startedAt: meta.startedAt,
    commit: meta.commit,
    model: meta.model,
    flows,
    summary: {
      pass: all.filter((a) => a.status === 'pass').length,
      fail: all.filter((a) => a.status === 'fail').length,
      skip: all.filter((a) => a.status === 'skip').length,
      stable3: flows.filter((f) => f.stable).length,
    },
  };
}

/** 只有每一次尝试都通过才算绿（skip 也不算绿）。 */
export function exitCodeFor(result: CoreResult): number {
  return result.summary.fail === 0 && result.summary.skip === 0 && result.summary.pass > 0 ? 0 : 1;
}

export function formatFailure(flowId: string, attempt: AttemptResult): string {
  const step = attempt.failedStep;
  const word = attempt.status === 'skip' ? 'SKIP' : 'FAIL';
  const head = step ? `${word} ${flowId} step ${step.n}: ${step.text}` : `${word} ${flowId}`;
  return [
    head,
    `  attempt: ${attempt.n}${attempt.reason ? `  reason: ${attempt.reason}` : ''}`,
    `  screenshot: ${attempt.screenshot ?? '-'}`,
    `  sse: ${attempt.sse ?? '-'}`,
    `  db: ${attempt.db ?? '-'}`,
  ].join('\n');
}
