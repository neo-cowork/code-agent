// npm run test:e2e:core —— 一条命令跑全部核心 Web 路径（真实服务 + dogfood 模型），写 result.json。
// 地图 18 条里 web 可跑的 11 条都在这（F05-F10 F14-F18）；其余 7 条 shell 流程见 flows.ts 的 SHELL_WEB_FLOWS。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { parseArgs } from './args';
import { pickSlotFlows } from './calendarFlows';
import { CORE_FLOWS, CORE_FLOW_IDS } from './flows';
import { buildAttempt, buildFlowResult, buildResult, exitCodeFor, formatFailure, type AttemptResult, type FlowResult } from './result';
import { assertRealrunBin, cancelSessions, captureEvents, dumpDb, quiesceServer, startServer, stopServer } from './server';
import { attachSlot, dumpSlotDb } from './slotAttach';
import type { AttemptEnv, DbSnapshot, FlowDef, ServerInfo } from './types';
import { dismissFirstRunLayers, setDeliveryProbe, setStallRecovery } from './ui';

const ATTEMPT_CAP_MS = 12 * 60_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 读一份新快照：隔离服务走 neo-realrun dump，挂靠槽走只读 better-sqlite3（slotAttach）。 */
type ReadDbFn = (server: ServerInfo) => Promise<{ file: string; data: DbSnapshot }>;

async function runAttempt(flow: FlowDef, n: number, ctx: { browser: Browser; server: ServerInfo; bin: string; out: string; slot: boolean; readDb: ReadDbFn }): Promise<AttemptResult> {
  const { browser, server, bin, out, slot, readDb } = ctx;
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
    page, server, sessionIds: [], startedAtMs: Date.now(), sseFile, scratch: {},
    note: (text) => { if (!notes.includes(text)) notes.push(text); },
    readDb: async () => { const r = await readDb(server); lastDb = r.file; return r; },
  };
  setDeliveryProbe(async (since) => (await env.readDb()).data.permissionDecisions.some((r) => Number(r.recorded_at) >= since - 2_000));
  setStallRecovery(async () => {
    env.note('页面 75 秒没有任何变化，刷新页面重新载入会话后继续（疑似页面漏掉了事件，见 sse）');
    await page.reload();
    await page.getByTestId('sidebar-new-task').waitFor({ timeout: 30_000 });
    const id = env.sessionIds[env.sessionIds.length - 1];
    if (id) await page.locator(`[data-session-id="${id}"]`).first().click({ timeout: 15_000 }).catch(() => {});
  });
  const started = Date.now();
  // 挂靠槽不做 quiesce / kill9 / restart：那是 neo-realrun 对自己起的服务才有的权限
  const restarted = slot ? null : await quiesceServer(bin, server);
  if (restarted) env.note(restarted);
  await flow.prepare?.(server);
  let failedStep: AttemptResult['failedStep'] = null;
  let reason = '';
  try {
    await page.goto(`${origin}/`);
    await page.getByTestId('sidebar-new-task').waitFor({ timeout: 30_000 });
    // 首启流程（F18 一类）要用首启弹层，默认的「点掉首启弹层」对它们关掉
    if (!flow.requiresFirstRun) await dismissFirstRunLayers(page);
    // step 0 探针（日历流程）：没发任何消息之前先验前提；红在 step 0，本次尝试不再跑步骤（详情走 env.note → reason）
    try {
      await flow.probe?.(env);
    } catch (e) {
      failedStep = { n: 0, text: (e as Error).message };
    }
    if (!failedStep) {
      for (const [i, step] of flow.steps.entries()) {
        try {
          await step.run(env);
        } catch (e) {
          failedStep = { n: i + 1, text: step.text };
          reason = (e as Error).message;
          break;
        }
      }
    }
  } catch (e) {
    if (!failedStep) failedStep = { n: 0, text: '打开页面并进入聊天界面' };
    reason = (e as Error).message;
  } finally {
    // 收尾护栏（F17 恢复界面语言 / 日历流程清本标记的事件）：步骤红不红都要跑，失败只记 note 不掩盖原失败
    try {
      await flow.cleanup?.(server, env);
    } catch (e) {
      notes.push(`cleanup 失败：${(e as Error).message}`);
    }
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
async function runIsolated(flow: FlowDef, n: number, ctx: { headed: boolean; server: ServerInfo; bin: string; out: string; slot: boolean; readDb: ReadDbFn }): Promise<AttemptResult> {
  const started = Date.now();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: !ctx.headed });
    return await Promise.race([
      runAttempt(flow, n, { browser, server: ctx.server, bin: ctx.bin, out: ctx.out, slot: ctx.slot, readDb: ctx.readDb }),
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
  // --slot 模式不用 neo-realrun；只有自建隔离服务才需要它
  if (!args.slot) assertRealrunBin(args.realrunBin);
  // F16 要用 POST /api/dev/seed-messages 种长会话：它只认 CODE_AGENT_E2E=1（dev.ts），
  // neo-realrun 只开 CODE_AGENT_ENABLE_DEV_API。种子写进的是本次隔离 HOME 的库，先于起服务设好
  // （该标志在隔离服务里只是多放行 e2e 种子钩子、少连 MCP/auth/telemetry 这类本次用不到的远端）。
  process.env.CODE_AGENT_E2E ??= '1';
  const startedAt = new Date().toISOString();
  // --slot 的缺省清单与 foreign 校验都在 pickSlotFlows 里：不带 --only 就是四条日历流程
  const wanted = args.only ?? CORE_FLOW_IDS;
  const flows = args.slot
    ? pickSlotFlows(args.only)
    : CORE_FLOWS.filter((f) => wanted.includes(f.id));
  if (!args.slot && !args.reuseBuild) {
    console.log('构建 web + renderer …');
    execFileSync('npm', ['run', '-s', 'build:web'], { cwd: REPO_ROOT, stdio: 'inherit' });
    execFileSync('npm', ['run', '-s', 'build:renderer'], { cwd: REPO_ROOT, stdio: 'inherit' });
  }
  fs.mkdirSync(args.out, { recursive: true });
  const readDb: ReadDbFn = args.slot
    ? (server) => Promise.resolve(dumpSlotDb(server, args.slot as number, args.out))
    : (server) => Promise.resolve(dumpDb(args.realrunBin, server));
  const server = args.slot
    ? await attachSlot(args.slot, args.out)
    : startServer(args.realrunBin, REPO_ROOT, args.out);
  const results: FlowResult[] = [];
  try {
    for (const flow of flows) {
      const attempts: AttemptResult[] = [];
      for (let n = 1; n <= args.repeat; n++) {
        const attempt = await runIsolated(flow, n, { headed: args.headed, server, bin: args.realrunBin, out: args.out, slot: args.slot !== null, readDb });
        attempts.push(attempt);
        console.log(attempt.status === 'pass'
          ? `PASS ${flow.id} attempt ${n} (${Math.round(attempt.durationMs / 1000)}s)${attempt.reason ? ` — ${attempt.reason}` : ''}`
          : formatFailure(flow.id, attempt));
      }
      results.push(buildFlowResult(flow.id, flow.title, attempts));
    }
  } finally {
    // 挂靠槽不是我们起的服务：只清自己的会话，从不 stop / kill9 / restart 槽
    if (!args.slot) {
      try { stopServer(args.realrunBin, server); } catch (e) { console.error(`e2e-core: 停服务失败：${(e as Error).message}`); process.exitCode = 1; }
    }
  }
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const result = buildResult({ startedAt, commit, model: server.model }, results);
  const file = path.join(args.out, 'result.json');
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`result.json: ${file}\nsummary: ${JSON.stringify(result.summary)}`);
  return exitCodeFor(result);
}

main().then((code) => { process.exit(process.exitCode || code); }, (e) => { console.error(`e2e-core: ${(e as Error).message}`); process.exit(1); });
