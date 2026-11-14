/** Real-session compaction comparison. Never writes session text or needles.
 * Usage: tsx scripts/acceptance/jev-compaction-eval.ts <session-dir>
 *        tsx scripts/acceptance/jev-compaction-eval.ts --dev-db [--inventory]
 * Owner override 2026-11-13: current dogfood subscription, never DeepSeek/GLM.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Message } from '../../src/shared/contract';
import type { ProjectableMessage } from '../../src/host/context/projectionEngine';
import { estimateConversationTokens, estimateTokens } from '../../src/host/context/tokenEstimator';
import { JEV_MODEL, estimateJevCallUsd, type JevSystemOneCall } from '../../src/shared/constants/jevQuestions';
import { resolveModelPrice } from '../../src/shared/pricing/resolveModelPrice';

// Orchestrator 2026-11-14: use the previously inventoried 15, directional only.
const MIN_SESSIONS = 15;
const MIN_RESULTS = 20;
const MIN_TOKENS = 30_000;
const BUDGET_USD = 3;
const RECENT = 10;
const OUTPUT = 'docs/research/assets/2026-09-30-jev-eval/compaction.json';
const PRIVATE_ROOT = path.join(os.homedir(), 'work/out/N-JEV-COMPACTION-EVAL');
type Session = { id: string; origin: string; messages: Message[] };
type Arm = { tokens: number; retained: number; retention: number; ms: number; calls: number;
  inputTokens: number; outputTokens: number; usd?: number; rejected: number };
type Row = { id: string; beforeTokens: number; needles: number; S: Arm; J: Arm;
  skipped: number; unavailable: number; badShape: number };

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function resultTexts(message: Message): string[] {
  if (message.toolResults?.length) {
    return message.toolResults.map((result) => result.output || result.error || '');
  }
  return message.role === 'tool' ? [message.content] : [];
}

function resultCount(messages: Message[]): number {
  return messages.reduce((n, message) => n + resultTexts(message).length, 0);
}

function extractNeedles(messages: Message[]): string[] {
  const patterns = [
    /(?:\/[A-Za-z0-9_.~-]+){2,}(?:\.[A-Za-z0-9]+)?/g,
    /\b(?:E[A-Z][A-Z0-9_]{2,}|[A-Z][A-Z0-9_]*_ERROR|[Ee]xit(?:\s+[Cc]ode|_code|Code)?\s*[:=]?\s*-?\d+)\b/g,
    /\b\d+(?:\.\d+)?\s*(?:ms|seconds?|secs?|minutes?|mins?|hours?|MB|GB|KB|MiB|GiB|bytes?|tokens?|px|%)\b/gi,
    /`[A-Za-z_$][\w.$:/-]*`/g,
  ];
  const buckets = patterns.map(() => new Set<string>());
  for (const message of messages.slice(0, -RECENT)) {
    for (const text of resultTexts(message)) {
      patterns.forEach((pattern, index) => {
        // Bound extraction memory on multi-megabyte real tool results.
        for (const match of text.matchAll(pattern)) {
          buckets[index].add(match[0]);
          if (buckets[index].size >= 5) break;
        }
      });
    }
  }
  const needles = new Set<string>();
  // Deterministic round robin across the four rules, then source order.
  for (let offset = 0; offset < 5; offset++) {
    for (const bucket of buckets) {
      const value = [...bucket][offset];
      if (value) needles.add(value);
      if (needles.size === 5) return [...needles];
    }
  }
  return [...needles];
}

function retention(needles: string[], messages: Array<{ content: string; toolCalls?: unknown }>) {
  // Surviving call arguments are also in the model-visible transcript. A path
  // retained there still survives even if its corresponding result is dropped.
  const transcript = messages.map((message) => message.content
    + (message.toolCalls ? '\n' + JSON.stringify(message.toolCalls) : '')).join('\n');
  const retained = needles.filter((needle) => transcript.includes(needle)).length;
  return { retained, retention: needles.length ? retained / needles.length : 0 };
}

/** Match the durable tool-result expansion in contextAssembly/transcriptProjection.ts.
 * No runtime pruning, attachment decoding, or fabricated call/result pairs.
 */
function project(messages: Message[]): ProjectableMessage[] {
  return messages.flatMap((message): ProjectableMessage[] => {
    if (message.role === 'tool' && message.toolResults?.length) {
      return message.toolResults.map((result, index) => ({
        id: `${message.id}::tool-result::${result.toolCallId || index}`,
        role: 'tool', content: result.output || result.error || '',
        toolCallId: result.toolCallId, timestamp: message.timestamp,
      }));
    }
    return [{ ...message, ...(message.toolCalls?.length ? {} : { toolCalls: undefined }) }];
  });
}

function tokens(messages: ProjectableMessage[]): number {
  return estimateConversationTokens(messages.map((message) => ({
    id: message.id, role: message.role as Message['role'], content: message.content,
    timestamp: typeof message.timestamp === 'number' ? message.timestamp : 0,
    ...(Array.isArray(message.attachments) ? { attachments: message.attachments as Message['attachments'] } : {}),
  })));
}

function validateSession(value: unknown): Session {
  const session = value as Session;
  check(session && typeof session.id === 'string' && /^[\w-]+$/.test(session.id), 'invalid_session_id');
  check(typeof session.origin === 'string' && Array.isArray(session.messages), 'invalid_session_shape');
  const ids = new Set<string>();
  for (const message of session.messages) {
    check(typeof message.id === 'string' && !ids.has(message.id), 'invalid_message_id');
    ids.add(message.id);
    check(['system', 'user', 'assistant', 'tool'].includes(message.role)
      && typeof message.content === 'string' && Number.isFinite(message.timestamp), 'invalid_message_shape');
  }
  return session;
}

function readDevSessions(): { sessions: Session[]; totalSessions: number } {
  // readOnly opens the existing WAL database without altering its contents.
  const db = new DatabaseSync(path.join(os.homedir(), '.code-agent-dev/code-agent.db'), { readOnly: true });
  try {
    db.exec('BEGIN');
    const totalSessions = Number((db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n);
    const candidates = db.prepare(`SELECT m.session_id AS id, s.origin FROM messages m
      JOIN sessions s ON s.id=m.session_id WHERE m.visibility='active'
      GROUP BY m.session_id HAVING sum(CASE WHEN m.tool_results IS NOT NULL
        THEN json_array_length(m.tool_results) WHEN m.role='tool' THEN 1 ELSE 0 END)>=?
      ORDER BY m.session_id`).all(MIN_RESULTS) as unknown as Array<{ id: string; origin: string | null }>;
    const query = db.prepare(`SELECT id,role,content,timestamp,tool_calls,tool_results,attachments,compaction,metadata,thinking
      FROM messages WHERE session_id=? AND visibility='active' ORDER BY timestamp,rowid`);
    const sessions = candidates.map(({ id, origin }) => {
      let kind = 'unrecorded';
      if (origin) {
        const parsed = JSON.parse(origin) as { kind?: string };
        if (parsed.kind === 'cron' || parsed.kind === 'manual') kind = parsed.kind;
      }
      const messages = query.all(id).map((row) => ({
        id: row.id, role: row.role, content: row.content, timestamp: row.timestamp,
        ...(row.tool_calls ? { toolCalls: JSON.parse(String(row.tool_calls)) } : {}),
        ...(row.tool_results ? { toolResults: JSON.parse(String(row.tool_results)) } : {}),
        ...(row.attachments ? { attachments: JSON.parse(String(row.attachments)) } : {}),
        ...(row.compaction ? { compaction: JSON.parse(String(row.compaction)) } : {}),
        ...(row.metadata ? { metadata: JSON.parse(String(row.metadata)) } : {}),
        ...(row.thinking ? { thinking: String(row.thinking) } : {}),
      })) as Message[];
      return validateSession({ id, origin: `dev-dogfood/${kind}`, messages });
    });
    return { sessions, totalSessions };
  } finally {
    db.close();
  }
}

function readDirectory(directory: string): { sessions: Session[]; totalSessions: number } {
  if (!fs.existsSync(directory)) return { sessions: [], totalSessions: 0 };
  const files = fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort();
  const sessions = files.map((file) => validateSession(JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'))));
  return { sessions, totalSessions: files.length };
}

function selfCheck(): void {
  const sample: Message[] = [
    { id: 'a', role: 'tool', content: '/tmp/eval/input.csv ENOENT 42 ms `fixture_id` /tmp/eval/output.csv', timestamp: 1 },
    { id: 'b', role: 'user', content: 'continue', timestamp: 2 },
    { id: 'c', role: 'assistant', content: 'done', timestamp: 3 },
  ];
  // The requested three-message sample is wholly inside the newest-10 window.
  assert.deepEqual(extractNeedles(sample), []);
  const aged = [...sample, ...Array.from({ length: 10 }, (_, index): Message => ({
    id: `recent-${index}`, role: 'user', content: '/tmp/recent/ignored.csv', timestamp: 4 + index,
  }))];
  const needles = extractNeedles(aged);
  assert.deepEqual(needles, ['/tmp/eval/input.csv', 'ENOENT', '42 ms', '`fixture_id`', '/tmp/eval/output.csv']);
  assert.equal(retention(needles, sample).retained, 5);
  assert.equal(retention(needles, [{ content: 'ENOENT 42 ms' }]).retention, 0.4);
  assert.equal(retention(needles, [{ content: 'enoent 42 MS' }]).retained, 0);
  assert.equal(extractNeedles([...aged, ...aged]).length, 5);
  assert.equal(extractNeedles(aged).some((needle) => needle.includes('ignored')), false);
  assert.equal(retention([], sample).retained, 0);
  const withResults: Message = { ...sample[0], toolResults: [{ toolCallId: 'call-a', success: true, output: 'EACCES' }] };
  assert.deepEqual(extractNeedles([withResults, ...aged.slice(-10)]), ['EACCES']);
  assert.equal(project([withResults])[0].toolCallId, 'call-a');
  assert.equal(project([withResults])[0].content, 'EACCES');
  assert.equal(resultCount([withResults]), 1);
  assert.equal(tokens(project(sample)), estimateConversationTokens(sample));
  assert.equal(JEV_MODEL, 'jev-1.13.0');
  assert.ok(Math.abs(estimateJevCallUsd(400, 0) - 0.0000042) < 1e-12);
  assert.equal(retention(['/tmp/eval/input.csv'], [{ content: '',
    toolCalls: [{ id: 'call-a', name: 'read_file', arguments: { path: '/tmp/eval/input.csv' } }] }]).retained, 1);
  console.log('self-check: 16 passed / 0 failed / 0 skipped; network_calls=0');
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function evaluate(sessions: Session[], needlesById: Map<string, string[]>): Promise<void> {
  const dogfood = fs.readFileSync(path.join(os.homedir(), '.ship/grab/realrun-dev-model'), 'utf8').trim();
  check(dogfood === 'xiaomi', 'unsupported_dogfood_provider: explicitly configure the current subscription before running');
  check(process.env.XIAOMI_API_KEY?.trim(), 'missing_credentials: XIAOMI_API_KEY=unset');
  check(process.env.XIAOMI_API_URL?.trim(), 'missing_configuration: XIAOMI_API_URL=unset');
  const baseline = { provider: 'xiaomi' as const, model: process.env.XIAOMI_MODEL || 'mimo-v2.6-flash' };
  const price = resolveModelPrice(baseline.provider, baseline.model);
  check(price.inputPerMTok !== undefined && price.outputPerMTok !== undefined, 'baseline_price_missing');
  console.log(`baseline=${baseline.provider}/${baseline.model} billing=subscription`);

  // Set before any production module import, including logger/config singletons.
  fs.mkdirSync(PRIVATE_ROOT, { recursive: true, mode: 0o700 });
  const dataDir = fs.mkdtempSync(path.join(PRIVATE_ROOT, 'config-'));
  process.env.CODE_AGENT_DATA_DIR = dataDir;
  process.env.CODE_AGENT_CLI_MODE = 'true';
  process.env.CODE_AGENT_JEV_COMPACTION = '1';
  // Isolated config never borrows OpenRouter/hosted credentials or relay settings.
  fs.writeFileSync(path.join(dataDir, '.env'), '', { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    model: baseline,
    contextCompression: { compactProvider: baseline.provider, compactModel: baseline.model },
    models: { providers: { xiaomi: { enabled: true, baseUrl: process.env.XIAOMI_API_URL } } },
    jev: { enabled: true, openRouterConsent: false, neoHostedEnabled: false },
  }), { mode: 0o600 });

  const { getConfigService } = await import('../../src/host/services/core/configService');
  await getConfigService().initialize();
  const { createCompactionPlan, summarizeCompactionPlan } = await import('../../src/host/context/compactionService');
  const { ModelRouter } = await import('../../src/host/model/modelRouter');
  const { applyJevCompaction } = await import('../../src/host/context/jevCompaction');
  const { systemOne, resolveJevRoute } = await import('../../src/host/model/providers/typesafeProvider');
  const route = resolveJevRoute();
  check(route?.kind === 'official' && route.model === JEV_MODEL, 'jev_official_route_required');
  const budgetPath = path.join(PRIVATE_ROOT, 'paid-budget.json');
  const previousPaidUsd = fs.existsSync(budgetPath)
    ? Number((JSON.parse(fs.readFileSync(budgetPath, 'utf8')) as { reservedUsd: number }).reservedUsd) : 0;
  check(Number.isFinite(previousPaidUsd) && previousPaidUsd >= 0, 'invalid_paid_budget_ledger');
  let paidUsd = 0;
  let financialAbort = false;
  const reserve = (usd: number) => {
    if (previousPaidUsd + paidUsd + usd > BUDGET_USD) {
      financialAbort = true;
      throw new Error('budget_exceeded: next call would exceed $3');
    }
    paidUsd += usd; // Includes failed attempts conservatively.
    fs.writeFileSync(budgetPath, JSON.stringify({ reservedUsd: previousPaidUsd + paidUsd }) + '\n', { mode: 0o600 });
  };
  let summaryCalls = 0;
  let summaryIn = 0;
  let summaryOut = 0;
  // Production streaming uses node:http, not fetch. Observe the real router,
  // delegating unchanged; each repair is another inference with its own usage.
  const originalInference = ModelRouter.prototype.inference;
  ModelRouter.prototype.inference = async function (...args: Parameters<typeof originalInference>) {
    const [messages, , config] = args;
    check(config.provider === baseline.provider && config.model === baseline.model, 'summary_request_model_mismatch');
    check(config.baseUrl === process.env.XIAOMI_API_URL, 'summary_endpoint_mismatch');
    summaryCalls++;
    const response = await originalInference.apply(this, args);
    summaryIn += response.usage?.inputTokens ?? estimateTokens(JSON.stringify(messages));
    summaryOut += response.usage?.outputTokens ?? estimateTokens(response.content || '');
    return response;
  };
  const rows: Row[] = [];
  try {
    for (const session of sessions) {
      const needles = needlesById.get(session.id)!;
      const original = project(session.messages);
      const sMessages = structuredClone(session.messages);
      const startedS = performance.now();
      // Single-user long sessions have no safe span in manual_current's
      // latest-user heuristic. The existing explicit-anchor API preserves the
      // same trailing ten messages and still adjusts for tool pair integrity.
      const plan = createCompactionPlan({ sessionId: session.id, source: 'manual_from_message',
        anchorMessageId: sMessages[Math.max(2, sMessages.length - RECENT)]?.id,
        messages: sMessages, skipAudit: true });
      check(plan, 'summary_plan_missing');
      const callsBefore = summaryCalls;
      const inBefore = summaryIn;
      const outBefore = summaryOut;
      const summary = await summarizeCompactionPlan(plan);
      check(summary.summaryModel.provider === baseline.provider && summary.summaryModel.model === baseline.model,
        'summary_metadata_model_mismatch');
      const summaryContent = '[Context Handoff] Another language model worked on this task and produced the following summary. Use this to build on the work already done.\n\n' + summary.summary;
      const admitted = summary.validation.ok && estimateTokens(summaryContent) < plan.originalTokens;
      const sAfter = admitted ? project([{ id: 'eval-summary', role: 'system', content: summaryContent, timestamp: 0 }, ...plan.preservedMessages]) : original;
      const S: Arm = { tokens: tokens(sAfter), ...retention(needles, sAfter), ms: Math.round(performance.now() - startedS),
        calls: summaryCalls - callsBefore, inputTokens: summaryIn - inBefore, outputTokens: summaryOut - outBefore,
        rejected: Number(!admitted) };
      const jMessages = structuredClone(original);
      let jevUsd = 0;
      let jevCalls = 0;
      let jevInput = 0;
      const spy: JevSystemOneCall = async (state, questions, options) => {
        const stateChars = JSON.stringify(state).length;
        const questionChars = JSON.stringify(questions).length;
        const usd = estimateJevCallUsd(stateChars, questionChars);
        reserve(usd);
        jevUsd += usd;
        jevCalls++;
        jevInput += Math.ceil((stateChars + questionChars) / 4);
        return systemOne(state, questions, options);
      };
      const startedJ = performance.now();
      const result = await applyJevCompaction(jMessages, spy);
      check(!financialAbort, 'budget_exceeded: no JSON');
      check(jevCalls > 0, 'jev_no_real_calls');
      const J: Arm = { tokens: tokens(jMessages), ...retention(needles, jMessages), ms: Math.round(performance.now() - startedJ),
        usd: jevUsd, calls: jevCalls, inputTokens: jevInput, outputTokens: 0, rejected: Number(result.skipped) };
      rows.push({ id: session.id, beforeTokens: tokens(original), needles: needles.length, S, J,
        skipped: Number(result.skipped), unavailable: Number(result.reason === 'unavailable'), badShape: Number(result.reason === 'bad_shape') });
      console.log(`row=${session.id} summaryModel=${summary.summaryModel.provider}/${summary.summaryModel.model} S=${JSON.stringify(S)} J=${JSON.stringify(J)}`);
    }
  } finally {
    ModelRouter.prototype.inference = originalInference;
  }
  check(rows.filter((row) => row.unavailable || row.badShape).length / rows.length <= 0.1, 'jev_unavailable_or_bad_shape_over_10_percent');
  const stats = (arm: 'S' | 'J'): { totals: Record<string, number>; medians: Record<string, number> } => {
    const values = rows.map((row) => row[arm]);
    const fields = ['tokens', 'retained', 'ms', 'calls', 'inputTokens', 'outputTokens', 'rejected'] as const;
    return {
      totals: { ...Object.fromEntries(fields.map((key) => [key, values.reduce((sum, value) => sum + value[key], 0)])),
        needles: rows.reduce((sum, row) => sum + row.needles, 0), ...(arm === 'J' ? { usd: paidUsd } : {}) },
      medians: { ...Object.fromEntries([...fields, 'retention' as const].map((key) => [key, median(values.map((value) => value[key]))])),
        ...(arm === 'J' ? { usd: median(values.map((value) => value.usd!)) } : {}) },
    };
  };
  const S = stats('S');
  const J = stats('J');
  // String values are session ids only; model/billing metadata are named keys.
  const report = { baselineSubscription: { [baseline.provider]: { [baseline.model]: 1 } }, jevModel: { [JEV_MODEL]: 1 },
    originalPlannedSessions: 20, authorizedSessions: MIN_SESSIONS, evaluatedSessions: rows.length, directionalOnly: 1,
    budgetUsd: BUDGET_USD, paidUsd, previousAttemptsPaidUsd: previousPaidUsd,
    cumulativePaidUsd: previousPaidUsd + paidUsd, rows, S, J };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log('| id | arm | post tokens | facts retained | wall ms | cost |');
  console.log('|---|---|---:|---:|---:|---|');
  for (const row of rows) {
    for (const arm of ['S', 'J'] as const) {
      const value = row[arm];
      console.log(`| ${row.id} | ${arm} | ${value.tokens} | ${value.retained}/${row.needles} | ${value.ms} | ${arm === 'S' ? 'subscription' : '$' + value.usd!.toFixed(8)} |`);
    }
  }
  console.log(`totals S=${JSON.stringify(S)} J=${JSON.stringify(J)}`);
  console.log(`n=${rows.length} original_planned_n=20 directional_only=1`);
  console.log(J.medians.retention < S.medians.retention ? '不接电只留报告' : '可接电候选');
  console.log(`token_delta_J_minus_S=${J.totals.tokens - S.totals.tokens} USD_delta=not_comparable_subscription S=subscription J=$${paidUsd.toFixed(8)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--self-check')) return selfCheck();
  check(!fs.existsSync(path.join(os.homedir(), '.ship/disabled')), 'automation_disabled');
  check(JEV_MODEL === 'jev-1.13.0', 'jev_model_mismatch');
  const inventoryOnly = args.includes('--inventory');
  if (!inventoryOnly) {
    console.log(`TYPESAFE_API_KEY=${process.env.TYPESAFE_API_KEY?.trim() ? 'set' : 'unset'}`);
    check(process.env.TYPESAFE_API_KEY?.trim(), 'missing_credentials: TYPESAFE_API_KEY=unset; network_calls=0; JSON_written=0');
    check(!fs.existsSync(OUTPUT), 'output_already_exists: preserve previous run; choose a fresh checkout');
  }
  const source = args.includes('--dev-db') ? readDevSessions() : readDirectory(args.find((arg) => !arg.startsWith('--')) || path.join(os.homedir(), 'work/jev-eval/compaction-sessions'));
  const selectionPath = args.find((arg) => arg.startsWith('--session-ids='))?.slice('--session-ids='.length);
  const selectedIds: unknown = selectionPath ? JSON.parse(fs.readFileSync(selectionPath, 'utf8')) : undefined;
  if (selectedIds !== undefined) {
    check(Array.isArray(selectedIds) && selectedIds.length === MIN_SESSIONS
      && selectedIds.every((id) => typeof id === 'string' && /^[\w-]+$/.test(id))
      && new Set(selectedIds).size === MIN_SESSIONS, 'invalid_authorized_session_ids');
    source.sessions = source.sessions.filter((session) => selectedIds.includes(session.id));
  }
  const qualified: Session[] = [];
  const needlesById = new Map<string, string[]>();
  const ids = new Set<string>();
  console.log('| id | origin | tool results | estimated tokens | eligible |');
  console.log('|---|---|---:|---:|---:|');
  for (const session of source.sessions) {
    check(!ids.has(session.id), 'duplicate_session_id');
    ids.add(session.id);
    const results = resultCount(session.messages);
    const estimated = estimateConversationTokens(session.messages);
    const eligible = results >= MIN_RESULTS && estimated >= MIN_TOKENS;
    // JSON origin can contain private names: print only a fixed source category.
    console.log(`| ${session.id} | ${args.includes('--dev-db') ? session.origin : 'session-json'} | ${results} | ${estimated} | ${Number(eligible)} |`);
    if (eligible) {
      qualified.push(session);
      needlesById.set(session.id, extractNeedles(session.messages));
    }
  }
  console.log(`inventory: total=${source.totalSessions} candidates=${source.sessions.length} qualified=${qualified.length} required=${MIN_SESSIONS} network_calls=0 JSON_written=0`);
  check(qualified.length >= MIN_SESSIONS, 'BLOCKED: precondition (sessions); network_calls=0; JSON_written=0');
  if (!inventoryOnly) await evaluate(qualified.slice(0, MIN_SESSIONS), needlesById);
}

main().catch((error: unknown) => {
  if (process.argv.includes('--self-check') && error instanceof assert.AssertionError) {
    console.error(`self-check assertion: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  // Never expose provider error bodies, keys, paths, or session text.
  const safe = error instanceof Error && /^(?:[a-z_]+(?:[: _a-zA-Z0-9=;$().>-]+)?|BLOCKED: precondition \(sessions\); network_calls=0; JSON_written=0)$/.test(error.message)
    ? error.message : 'evaluation_failed: details suppressed to protect session content and credentials';
  console.error(safe);
  process.exitCode = 1;
});
