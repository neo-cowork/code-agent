import fs from 'node:fs';
import path from 'node:path';
import { formatFailure, STABLE_ATTEMPTS, type AttemptResult, type CoreResult, type FlowResult } from './result';

const EXIT_GREEN = 0;
const EXIT_RED = 2;
const EXIT_FLAKY = 3;
const EXIT_MISMATCH = 4;
const EXIT_SKIP = 5;
const EXIT_NO_RESULT = 6;
const EXIT_USAGE = 64;
const MIN_COMMIT_PREFIX = 7;
const ATTEMPT_STATUSES = new Set<AttemptResult['status']>(['pass', 'fail', 'skip']);

interface VerdictArgs {
  resultPath: string;
  expectedCommit: string | null;
}

const USAGE = 'Usage: npx tsx scripts/e2e-core/verdict.ts [--result <file>] [--commit <sha>]';

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

function parseCliArgs(argv: string[], cwd: string): VerdictArgs {
  let resultFile = 'test-results/e2e-core/result.json';
  let expectedCommit: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--result') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) throw new Error('Missing value for --result');
      resultFile = val;
    } else if (arg.startsWith('--result=')) {
      const val = arg.slice('--result='.length);
      if (!val) throw new Error('Missing value for --result');
      resultFile = val;
    } else if (arg === '--commit') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) throw new Error('Missing value for --commit');
      expectedCommit = val;
    } else if (arg.startsWith('--commit=')) {
      const val = arg.slice('--commit='.length);
      if (!val) throw new Error('Missing value for --commit');
      expectedCommit = val;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (expectedCommit !== null && expectedCommit.trim().length < MIN_COMMIT_PREFIX) {
    throw new Error(`--commit needs at least ${MIN_COMMIT_PREFIX} characters`);
  }

  return {
    resultPath: path.resolve(cwd, resultFile),
    expectedCommit,
  };
}

function commitsMatch(actual: string, expected: string): boolean {
  const a = actual.trim().toLowerCase();
  const b = expected.trim().toLowerCase();
  if (a.length < MIN_COMMIT_PREFIX || b.length < MIN_COMMIT_PREFIX) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function isValidCoreResult(value: unknown): value is CoreResult {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj.schema !== 1) return false;
  if (!Array.isArray(obj.flows) || obj.flows.length === 0) return false;
  return obj.flows.every(
    (flow) =>
      flow &&
      typeof flow === 'object' &&
      typeof (flow as FlowResult).id === 'string' &&
      Array.isArray((flow as FlowResult).attempts) &&
      (flow as FlowResult).attempts.every(
        (a) => a && typeof a === 'object' && ATTEMPT_STATUSES.has((a as AttemptResult).status),
      ),
  );
}

/** 与 formatFailure 首行同文案；skip 记的是「未评估」，跳过尝试不算进成败判据。 */
function evaluatedAttempts(flow: FlowResult): AttemptResult[] {
  return flow.attempts.filter((a) => a.status !== 'skip');
}

function evaluate(result: CoreResult, expectedCommit: string | null): { code: number; line: string } {
  const totalAttempts = result.flows.reduce((sum, f) => sum + f.attempts.length, 0);
  if (totalAttempts === 0) {
    return { code: EXIT_NO_RESULT, line: 'NO-RESULT: result contains zero attempts（无有效执行记录）' };
  }

  if (expectedCommit !== null) {
    const actualCommit = typeof result.commit === 'string' ? oneLine(result.commit) : '';
    if (!commitsMatch(actualCommit, expectedCommit)) {
      return {
        code: EXIT_MISMATCH,
        line: `MISMATCH: result commit ${actualCommit || '(empty)'} != expected ${oneLine(expectedCommit)}（提交不匹配）`,
      };
    }
  }

  const redFlows = result.flows.filter((f) => {
    const evaluated = evaluatedAttempts(f);
    return evaluated.length > 0 && evaluated.every((a) => a.status === 'fail');
  });
  if (redFlows.length > 0) {
    const first = redFlows[0];
    const firstFail = first.attempts.find((a) => a.status === 'fail')!;
    const head = formatFailure(first.id, firstFail).split('\n')[0];
    const more = redFlows.length > 1 ? ` (+${redFlows.length - 1} more)` : '';
    return { code: EXIT_RED, line: `${head}${more}` };
  }

  // 有真实失败的路径不归 SKIP：skip 只是「未评估」，fail 混 skip 由上面的 RED / 下面的 FLAKY 认领
  const hasFail = result.flows.some((f) => f.attempts.some((a) => a.status === 'fail'));
  const skipFlows = result.flows.filter((f) => f.attempts.some((a) => a.status === 'skip'));
  if (!hasFail && skipFlows.length > 0) {
    const first = skipFlows[0];
    const skippedAttempt = first.attempts.find((a) => a.status === 'skip')!;
    const head = formatFailure(first.id, skippedAttempt).split('\n')[0];
    const more = skipFlows.length > 1 ? ` (+${skipFlows.length - 1} more)` : '';
    return {
      code: EXIT_SKIP,
      line: `${head}${more} — environment not set up（环境未就绪，非路径失败）`,
    };
  }

  const flakyFlows = result.flows.filter((f) => {
    const evaluated = evaluatedAttempts(f);
    return evaluated.some((a) => a.status === 'pass') && evaluated.some((a) => a.status === 'fail');
  });
  if (flakyFlows.length > 0) {
    const first = flakyFlows[0];
    const evaluated = evaluatedAttempts(first);
    const passCount = evaluated.filter((a) => a.status === 'pass').length;
    const firstFail = evaluated.find((a) => a.status === 'fail')!;
    const stepPart = firstFail.failedStep
      ? `step ${firstFail.failedStep.n}: ${oneLine(firstFail.failedStep.text)}`
      : 'no failed step recorded';
    const more = flakyFlows.length > 1 ? ` (+${flakyFlows.length - 1} more)` : '';
    return {
      code: EXIT_FLAKY,
      line: `FLAKY ${first.id} (${passCount}/${evaluated.length} passed, ${stepPart})${more}`,
    };
  }

  const underRepeated = result.flows
    .filter((f) => f.attempts.length < STABLE_ATTEMPTS)
    .map((f) => `${f.id} ran only ${f.attempts.length} of ${STABLE_ATTEMPTS} repeats`);
  const suffix = underRepeated.length > 0 ? ` (${underRepeated.join(', ')})` : '';
  const commit = typeof result.commit === 'string' && result.commit.trim() ? oneLine(result.commit) : 'unknown';
  return {
    code: EXIT_GREEN,
    line: `GREEN ${commit}: ${result.flows.length} flows, ${totalAttempts} attempts passed${suffix}`,
  };
}

function main(): void {
  let args: VerdictArgs;
  try {
    args = parseCliArgs(process.argv.slice(2), process.cwd());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${msg}\n${USAGE}\n`);
    process.exit(EXIT_USAGE);
  }

  if (!fs.existsSync(args.resultPath)) {
    process.stdout.write(`NO-RESULT: result file not found (${args.resultPath})（结果文件不存在）\n`);
    process.exit(EXIT_NO_RESULT);
  }

  let parsed: unknown;
  try {
    const raw = fs.readFileSync(args.resultPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    process.stdout.write(`NO-RESULT: invalid JSON in ${args.resultPath}（结果文件无法解析）\n`);
    process.exit(EXIT_NO_RESULT);
  }

  if (!isValidCoreResult(parsed)) {
    process.stdout.write(`NO-RESULT: unsupported schema or empty flows in ${args.resultPath}（schema 不兼容或无流程）\n`);
    process.exit(EXIT_NO_RESULT);
  }

  const verdict = evaluate(parsed, args.expectedCommit);
  process.stdout.write(`${oneLine(verdict.line)}\n`);
  process.exit(verdict.code);
}

main();
