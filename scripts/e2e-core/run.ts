// npm run test:e2e:core —— 一条命令跑 5 条核心 Web 路径（真实服务 + dogfood 模型），写 result.json。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { parseArgs } from './args';
import { CORE_FLOWS, CORE_FLOW_IDS } from './flows';
import { buildAttempt, buildFlowResult, buildResult, exitCodeFor, formatFailure, type AttemptResult, type FlowResult } from './result';
import { assertRealrunBin, cancelSessions, captureEvents, dumpDb, ensureServerAlive, startServer, stopServer } from './server';
import type { AttemptEnv, FlowDef, ServerInfo } from './types';
import { dismissFirstRunLayers } from './ui';

const ATTEMPT_CAP_MS = 12 * 60_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function runAttempt(flow: FlowDef, n: number, ctx: { browser: Browser; server: ServerInfo; bin: string; out: string }): Promise<AttemptResult> {
  const { browser, server, bin, out } = ctx;
  const tag = `${flow.id}-a${n}`;
  const shots = path.join(out, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const sseFile = path.join(out, `${tag}.sse`);
  const stopCapture = captureEvents(server, sseFile);
  const origin = `http://127.0.0.1:${server.port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  // 页面像桌面壳一样带令牌访问本机服务：只给本服务的请求加头，不外泄给别的域名
  await context.route(`${origin}/**`, (route) => route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${server.token}` } }));
  const page = await context.newPage();
  const notes: string[] = [];
  let lastDb: string | null = null;
  const env: AttemptEnv = {
    page, server, sessionIds: [], startedAtMs: Date.now(), scratch: {},
    note: (text) => { if (!notes.includes(text)) notes.push(text); },
    readDb: async () => { const r = dumpDb(bin, server); lastDb = r.file; return r; },
  };
  const started = Date.now();
  const restarted = await ensureServerAlive(bin, server);
  if (restarted) env.note(restarted);
  await flow.prepare?.(server);
  let failedStep: AttemptResult['failedStep'] = null;
  let reason = '';
  try {
    await page.goto(`${origin}/`);
    await page.getByTestId('sidebar-new-task').waitFor({ timeout: 30_000 });
    await dismissFirstRunLayers(page);
    for (const [i, step] of flow.steps.entries()) {
      try {
        await step.run(env);
      } catch (e) {
        failedStep = { n: i + 1, text: step.text };
        reason = (e as Error).message;
        break;
      }
    }
  } catch (e) {
    failedStep = { n: 0, text: '打开页面并进入聊天界面' };
    reason = (e as Error).message;
  }
  let screenshot: string | null = path.join(shots, `${tag}-${failedStep ? 'fail' : 'pass'}.png`);
  await page.screenshot({ path: screenshot }).catch(() => { screenshot = null; });
  stopCapture();
  if (!lastDb) { try { await env.readDb(); } catch { /* 快照失败不掩盖原失败 */ } }
  await cancelSessions(server, env.sessionIds);
  await context.close();
  const reasonText = [reason && `${reason}`, ...notes].filter(Boolean).join('；');
  return buildAttempt({
    n, infra: /Target page, context or browser has been closed|Browser has been closed/.test(reason), failedStep, durationMs: Date.now() - started, screenshot, sse: sseFile, db: lastDb, reason: failedStep ? reasonText : notes.join('；'),
  });
}

// 每次尝试一个全新的浏览器：浏览器崩了只红这一次尝试，不拖垮整轮
async function runIsolated(flow: FlowDef, n: number, ctx: { headed: boolean; server: ServerInfo; bin: string; out: string }): Promise<AttemptResult> {
  const started = Date.now();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: !ctx.headed });
    return await Promise.race([
      runAttempt(flow, n, { browser, server: ctx.server, bin: ctx.bin, out: ctx.out }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`单次尝试超过 ${ATTEMPT_CAP_MS / 60_000} 分钟，强制结束`)), ATTEMPT_CAP_MS)),
    ]);
  } catch (e) {
    return buildAttempt({
      n, infra: /has been closed/.test((e as Error).message), failedStep: { n: 0, text: '浏览器或脚本异常中断' }, durationMs: Date.now() - started,
      screenshot: null, sse: null, db: null, reason: (e as Error).message,
    });
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), process.env, process.cwd());
  assertRealrunBin(args.realrunBin);
  const startedAt = new Date().toISOString();
  const wanted = args.only ?? CORE_FLOW_IDS;
  const flows = CORE_FLOWS.filter((f) => wanted.includes(f.id));
  if (!args.reuseBuild) {
    console.log('构建 web + renderer …');
    execFileSync('npm', ['run', '-s', 'build:web'], { cwd: REPO_ROOT, stdio: 'inherit' });
    execFileSync('npm', ['run', '-s', 'build:renderer'], { cwd: REPO_ROOT, stdio: 'inherit' });
  }
  fs.mkdirSync(args.out, { recursive: true });
  const server = startServer(args.realrunBin, REPO_ROOT, args.out);
  const results: FlowResult[] = [];
  try {
    for (const flow of flows) {
      const attempts: AttemptResult[] = [];
      for (let n = 1; n <= args.repeat; n++) {
        const attempt = await runIsolated(flow, n, { headed: args.headed, server, bin: args.realrunBin, out: args.out });
        attempts.push(attempt);
        console.log(attempt.status === 'pass'
          ? `PASS ${flow.id} attempt ${n} (${Math.round(attempt.durationMs / 1000)}s)${attempt.reason ? ` — ${attempt.reason}` : ''}`
          : formatFailure(flow.id, attempt));
      }
      results.push(buildFlowResult(flow.id, flow.title, attempts));
    }
  } finally {
    try { stopServer(args.realrunBin, server); } catch (e) { console.error(`e2e-core: 停服务失败：${(e as Error).message}`); process.exitCode = 1; }
  }
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const result = buildResult({ startedAt, commit, model: server.model }, results);
  const file = path.join(args.out, 'result.json');
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`result.json: ${file}\nsummary: ${JSON.stringify(result.summary)}`);
  return exitCodeFor(result);
}

main().then((code) => { process.exit(process.exitCode || code); }, (e) => { console.error(`e2e-core: ${(e as Error).message}`); process.exit(1); });
