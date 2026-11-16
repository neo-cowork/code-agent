#!/usr/bin/env node
/* global fetch, AbortSignal, Buffer, URL, setTimeout, document, window, getComputedStyle */
// neo-drive：按元素操作 + 按状态等待地驱动 Agent Neo，替代「截图坐标点按 + 固定 sleep」。
// 用法见 --help 与 docs/testing/neo-drive.md。测试工具，不进产品（src/host 的 osascript 禁令不适用于这里）。

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG_DIR_DEV } from '../../src/shared/constants/configDir.ts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const HOME_DIR = process.env.NEO_DRIVE_HOME || path.join(os.homedir(), '.cache', 'neo-drive');
const STATE_PATH = path.join(HOME_DIR, 'state.json');
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_EXIT_MS = 30 * 60_000;
const POLL_MS = 150;
const STEP_FIELDS = new Set(['do', 'always', 'timeout', 'text', 'target', 'session', 'id', 'model', 'expect', 'grace', 'within', 'tolerance',
  'screens', 'name', 'dir', 'service', 'process', 'role', 'deep', 'pattern', 'sql', 'empty', 'worktree', 'ifVisible']);
const VIEWPORT = { width: 1440, height: 900 };
const NEEDS_USER_SELECTORS = ['[data-testid="decision-slot"]', '[data-testid="env-assist-card"]', '[data-testid="parked-approval-card"]'];
const RUNNING_SELECTORS = ['[data-testid="composer-stop-button"]', '[data-testid="composer-stop-stopping"]'];
// 运行失败卡（AgentErrorCard 的 role=alert，aria-label 中英两份）与限流行：出现就是失败，不能当 idle。
const ERROR_SELECTORS = ['[role="alert"][aria-label="运行失败"]', '[role="alert"][aria-label="Run failed"]', '[data-testid="rate-limited-error-line"]'];

export const USAGE = `neo-drive — 按元素操作 + 按状态等待地驱动 Agent Neo（无头 / 真机）

浏览器（同一时刻只允许一个；${DEFAULT_IDLE_EXIT_MS / 60_000} 分钟无命令自动退出）:
  browser start --slotless[=标签] [--reuse-dist] | --dev[=槽号] | --url <http://127.0.0.1:端口> [--log-dir 目录]
  browser stop | browser status
页面（连常驻浏览器，页面不随命令退出而关闭）:
  new-session | open-session <会话 id|标题> | select-model <模型名> | reload | send <文本>
  wait-idle [--expect idle|needs-user] [--grace ms]（出现运行失败卡直接判失败） | wait-text <文本|/正则/>
  click <目标> | assert-visible <目标> | assert-bottom [--within ms] [--tolerance px]
  scroll-up [屏数] | scroll-down [屏数] | shot <名> [--dir 目录]
真机（macOS，Agent Neo Dev 槽；--slot N 选槽，缺省 1）:
  install <worktree> | quit | launch | reset-tcc <服务，如 Calendar>
  ax-click <元素名> [--process 进程名] [--role AXButton] [--deep]   （系统授权框: --process UserNotificationCenter；--deep 遍历整棵树，慢）
  wait-log <正则> | wait-db <SQL> | shot-window <名>
前置检查（真机先跑这个：确认 Dev 包有能用的模型）:
  preflight [模型名] [--slotless|--dev[=槽号]|--url <地址>]   新会话→切模型→发「你好」→正常回完即通过
  注意：select-model 会持久改写当前会话的模型，只在场景/preflight 自己新建的会话里用
场景:
  run <场景.json> [--slotless[=标签]|--dev[=槽号]|--url <地址>]   一次跑完，输出每步耗时 JSON
目标写法: 纯文本或 /正则/=按可见文字 | testid=<data-testid> | role=<角色>:<名称>（精确）或 role=<角色>:/正则/ | css=<选择器>
场景顶层 "model": "<模型名>"：每个 new-session 之后自动 select-model
通用: --timeout <ms>（缺省 ${DEFAULT_TIMEOUT_MS}） --json（每条命令输出 JSON）
文档: docs/testing/neo-drive.md`;

// ── 纯逻辑（单测覆盖） ─────────────────────────────────────────────────────

// ponytail: 槽号派生规则与 src/shared/devSlot.ts 同源（那份带无扩展名 import，node 直接跑不了）；
// tests/scripts/neoDrive.test.ts 逐槽对拍，规则一变测试就红。
export function devSlotInfo(raw) {
  const s = String(raw ?? '').trim() || '1';
  if (!/^[1-9]$/.test(s)) throw new Error(`槽号应为 1..9：${raw}`);
  const n = Number(s);
  return {
    slot: n,
    appName: n === 1 ? 'Agent Neo Dev' : `Agent Neo Dev ${n}`,
    bundleId: n === 1 ? 'com.linchen.code-agent.dev' : `com.linchen.code-agent.dev${n}`,
    dataDirName: n === 1 ? CONFIG_DIR_DEV : `${CONFIG_DIR_DEV}${n}`,
    port: 8180 + n,
  };
}

function asRegex(v) {
  return v.length > 2 && v.startsWith('/') && v.endsWith('/') ? new RegExp(v.slice(1, -1)) : null;
}

export function parseTarget(spec) {
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('目标不能为空');
  const s = spec.trim();
  if (s.startsWith('testid=')) return { kind: 'testid', value: s.slice(7) };
  if (s.startsWith('css=')) return { kind: 'css', value: s.slice(4) };
  if (s.startsWith('role=')) {
    const rest = s.slice(5);
    const i = rest.indexOf(':');
    if (i === -1) return { kind: 'role', role: rest, name: undefined };
    const name = rest.slice(i + 1);
    // /正则/ 用于按钮名里带快捷键提示等附加文字的情况（如「允许一次 y」写成 role=button:/^允许一次/）
    return { kind: 'role', role: rest.slice(0, i), name: asRegex(name) ?? name };
  }
  const text = s.startsWith('text=') ? s.slice(5) : s;
  return { kind: 'text', value: asRegex(text) ?? text };
}

/**
 * wait-idle 判定。sample = { t, running, cards: string[] }。
 * - 出现基线里没有的运行失败卡 → error（优先于一切，失败不能被当成 idle）
 * - 出现基线里没有的需人卡片 → needs-user（审批卡/授权卡/环境代修卡）
 * - 见过运行中之后，「运行中」连续 quietMs 不再出现 → idle（防工具间隙闪断误判）
 * - 一直没见到运行中：超过 startGraceMs 才按 idle 收（run 快到没采到的情况）
 */
function countBy(list) {
  const m = new Map();
  for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

function beyondBaseline(list, baseline) {
  const seen = new Map();
  return list.filter((x) => {
    const n = (seen.get(x) ?? 0) + 1;
    seen.set(x, n);
    return n > (baseline.get(x) ?? 0);
  });
}

export function createIdleTracker({ baselineCards = [], baselineErrors = [], seenRunning = false, quietMs = 800, startGraceMs = 3_000 } = {}) {
  // 按「同文案出现次数」做基线：同会话里第二张同文案的失败卡/审批卡也要算新出现的。
  const baseline = countBy(baselineCards);
  const baselineErr = countBy(baselineErrors);
  let sawRunning = seenRunning;
  let first;
  let quietSince;
  return (sample) => {
    first ??= sample.t;
    const errors = beyondBaseline(sample.errors ?? [], baselineErr);
    if (errors.length > 0) return { done: true, state: 'error', errors };
    const fresh = beyondBaseline(sample.cards, baseline);
    if (fresh.length > 0) return { done: true, state: 'needs-user', cards: fresh };
    if (sample.running) {
      sawRunning = true;
      quietSince = undefined;
      return { done: false };
    }
    if (!sawRunning && sample.t - first < startGraceMs) return { done: false };
    quietSince ??= sample.t;
    if (sample.t - quietSince >= quietMs) return { done: true, state: 'idle', sawRunning };
    return { done: false };
  };
}

/**
 * assert-visible 几何判定：矩形完全在视口与滚动容器内，且探测点最上层命中的是目标本身/子孙。
 * probe = { rect, viewport:{width,height}, clip: rect|null, hits: [{ok, by}] }
 */
export function visibilityVerdict({ rect, viewport, clip, hits }) {
  const eps = 0.5;
  if (!rect || rect.width <= 0 || rect.height <= 0) return { ok: false, reason: '元素没有尺寸（未渲染或被折叠）' };
  const boxes = [{ name: '视口', top: 0, left: 0, bottom: viewport.height, right: viewport.width }];
  if (clip) boxes.push({ name: '滚动容器', ...clip });
  for (const b of boxes) {
    if (rect.top < b.top - eps || rect.bottom > b.bottom + eps || rect.left < b.left - eps || rect.right > b.right + eps) {
      return { ok: false, reason: `元素超出${b.name}（元素 ${fmtRect(rect)}，${b.name} ${fmtRect(b)}）` };
    }
  }
  const blocked = hits.find((h) => !h.ok);
  if (blocked) return { ok: false, reason: `元素被遮挡：${blocked.by}` };
  return { ok: true };
}

function fmtRect(r) {
  return `top=${Math.round(r.top)} bottom=${Math.round(r.bottom)} left=${Math.round(r.left)} right=${Math.round(r.right)}`;
}

export function isAtBottom({ scrollHeight, scrollTop, clientHeight }, tolerance = 4) {
  return scrollHeight - scrollTop - clientHeight <= tolerance;
}

/** 场景文件：{ name?, steps: [{ do, ...参数, always? }] }；${ts} 替换成本次运行的时间戳。 */
export function parseScenario(raw, { ts = Date.now() } = {}) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || !Array.isArray(data.steps) || data.steps.length === 0) throw new Error('场景文件缺 steps 数组');
  const stamp = String(ts);
  const sub = (v) => (typeof v === 'string' ? v.replaceAll('${ts}', stamp) : v);
  const steps = data.steps.flatMap((step, i) => {
    if (!step || typeof step.do !== 'string') throw new Error(`第 ${i + 1} 步缺 do`);
    if (!(step.do in ACTIONS)) throw new Error(`第 ${i + 1} 步未知动作: ${step.do}`);
    // 字段名写错不许静默忽略（曾把 open-session 的 id 当没写，点了侧栏第一条还报 ok）。
    const unknown = Object.keys(step).filter((k) => !STEP_FIELDS.has(k));
    if (unknown.length) throw new Error(`第 ${i + 1} 步（${step.do}）有不认识的字段: ${unknown.join(', ')}`);
    const out = Object.fromEntries(Object.entries(step).map(([k, v]) => [k, sub(v)]));
    // 顶层 model：每次新会话后自动切到该模型（新会话默认模型可能是没配钥匙的服务商）。
    return data.model && step.do === 'new-session' ? [out, { do: 'select-model', model: data.model, ...(out.always ? { always: true } : {}) }] : [out];
  });
  return { name: data.name ?? 'scenario', model: data.model, steps };
}

/** 顺序执行；任一步失败后只再跑 always:true 的清理步。exec(step) 抛错=失败。 */
export async function runSteps(steps, exec, now = () => Date.now()) {
  const results = [];
  let failed = false;
  for (const step of steps) {
    if (failed && !step.always) {
      results.push({ do: step.do, ok: false, skipped: true, ms: 0 });
      continue;
    }
    const t0 = now();
    try {
      const detail = await exec(step);
      results.push({ do: step.do, ok: true, ms: now() - t0, ...(detail === undefined ? {} : { detail }) });
    } catch (error) {
      failed = true;
      results.push({ do: step.do, ok: false, ms: now() - t0, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: !failed, results };
}

/** 从各日志文件的上次偏移往后读新增内容（新文件从 0 读）。返回 { text, marks }。 */
export function readLogsSince(logDir, marks = {}) {
  const next = {};
  let text = '';
  if (!existsSync(logDir)) return { text, marks: next };
  for (const name of readdirSync(logDir)) {
    if (!name.endsWith('.log')) continue;
    const file = path.join(logDir, name);
    const size = statSync(file).size;
    // 文件比上次记的还短 = 被截断/轮转过，从头读，不然会漏掉轮转后写的行。
    const from = size < (marks[name] ?? 0) ? 0 : (marks[name] ?? 0);
    next[name] = size;
    if (size > from) {
      const fd = openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - from);
        readSync(fd, buf, 0, buf.length, from);
        text += buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
    }
  }
  return { text, marks: next };
}

export function logSizes(logDir) {
  if (!existsSync(logDir)) return {};
  return Object.fromEntries(readdirSync(logDir).filter((n) => n.endsWith('.log')).map((n) => [n, statSync(path.join(logDir, n)).size]));
}

export async function pollUntil(probe, { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = POLL_MS, what = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`等待${what}超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── 状态 / 常驻浏览器 ─────────────────────────────────────────────────────

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function liveState() {
  const state = readState();
  if (state && alive(state.browserPid)) return state;
  if (state) cleanupState(state);
  return null;
}

function touch(state, patch = {}) {
  const next = { ...state, ...patch, lastUsedAt: Date.now() };
  writeState(next);
  return next;
}

function headlessShellPath(chromium) {
  const full = chromium.executablePath();
  // Playwright 缓存布局：<cache>/chromium-<rev>/… 旁边是 <cache>/chromium_headless_shell-<rev>/chrome-headless-shell-<plat>/chrome-headless-shell
  const m = full.match(/^(.*)[/\\]chromium-(\d+)[/\\]/);
  if (m) {
    const dir = path.join(m[1], `chromium_headless_shell-${m[2]}`);
    if (existsSync(dir)) {
      for (const sub of readdirSync(dir)) {
        const exe = path.join(dir, sub, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
        if (existsSync(exe)) return { exe, headlessFlag: [] };
      }
    }
  }
  return { exe: full, headlessFlag: ['--headless=new'] };
}

async function resolveTarget(opts) {
  if (opts.url) {
    const u = new URL(opts.url);
    if (!['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('只接受本机地址');
    return { url: u.origin, logDir: opts.logDir ?? null, dataDir: null };
  }
  if (opts.dev !== undefined) {
    const info = devSlotInfo(opts.dev);
    const dataDir = path.join(os.homedir(), info.dataDirName);
    return { url: `http://127.0.0.1:${info.port}`, logDir: path.join(dataDir, 'logs'), dataDir, devSlot: info.slot };
  }
  if (opts.slotless !== undefined) {
    const label = typeof opts.slotless === 'string' && opts.slotless ? opts.slotless : 'neo-drive';
    const out = execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'verify-slotless.mjs'), label, ...(opts.reuseDist ? ['--reuse-dist'] : [])], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    });
    const url = out.match(/^NEO_VERIFY_URL=(.+)$/m)?.[1];
    const dataDir = out.match(/^NEO_VERIFY_DATA_DIR=(.+)$/m)?.[1];
    if (!url || !dataDir) throw new Error(`verify-slotless 没给出地址：\n${out}`);
    return { url, logDir: path.join(dataDir, 'logs'), dataDir, slotlessDataDir: dataDir };
  }
  throw new Error('需要 --slotless / --dev [槽] / --url <地址> 之一');
}

/** 已有常驻浏览器时，命令行显式给的目标必须和它一致；不一致就报错，绝不静默沿用旧目标去 quit/reset 别的槽。 */
export function targetConflict(state, opts) {
  if (!state) return null;
  if (opts.url !== undefined && new URL(opts.url).origin !== new URL(state.url).origin) return `--url ${opts.url}`;
  if (opts.dev !== undefined && state.devSlot !== devSlotInfo(opts.dev).slot) return `--dev=${opts.dev || 1}`;
  if (opts.slotless !== undefined && !state.slotlessDataDir) return '--slotless';
  if (opts.slot !== undefined && state.devSlot !== undefined && state.devSlot !== devSlotInfo(opts.slot).slot) return `--slot ${opts.slot}`;
  return null;
}

function assertNoConflict(state, opts) {
  const conflict = targetConflict(state, opts);
  if (conflict) throw new Error(`已有常驻浏览器连着 ${state.url}${state.devSlot ? `（Dev 槽 ${state.devSlot}）` : ''}，与 ${conflict} 不一致；先 browser stop`);
}

async function browserStart(opts) {
  const existing = liveState();
  if (existing) throw new Error(`已有常驻浏览器（pid ${existing.browserPid}，${existing.url}）；先 browser stop`);
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  const lockDir = path.join(HOME_DIR, 'start.lock');
  try {
    mkdirSync(lockDir);
  } catch {
    throw new Error(`另一个 browser start 正在进行（${lockDir}）；确认没有后可删掉该目录`);
  }
  let target;
  let partial;
  try {
    target = await resolveTarget(opts);
    const { chromium } = await import('playwright');
    const { exe, headlessFlag } = headlessShellPath(chromium);
    const userDataDir = mkdtempSync(path.join(HOME_DIR, 'profile-'));
    const child = spawn(exe, [...headlessFlag, '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
    partial = { browserPid: child.pid, userDataDir, ...target };
    const portFile = path.join(userDataDir, 'DevToolsActivePort');
    const cdpPort = await pollUntil(() => (existsSync(portFile) ? Number(readFileSync(portFile, 'utf8').split('\n')[0]) || null : null), { timeoutMs: 20_000, what: 'Chromium 调试端口' });
    let state = touch({ ...partial, browserPid: child.pid, cdpPort, userDataDir, exe, ...target, startedAt: new Date().toISOString(), idleExitMs: opts.idleExitMs ?? DEFAULT_IDLE_EXIT_MS });
    const watchdog = spawn(process.execPath, [fileURLToPath(import.meta.url), '__watchdog'], { detached: true, stdio: 'ignore', env: { ...process.env, NEO_DRIVE_HOME: HOME_DIR } });
    watchdog.unref();
    state = touch(state, { watchdogPid: watchdog.pid });
    partial = state;
    const { browser, page } = await connect(state);
    try {
      // 真机场景常以 quit→reset-tcc→launch 开头：应用没在跑时先停在空白页，交给场景里的 reload。
      if (target.devSlot && !(await healthy(new URL(target.url).port))) return { url: target.url, browserPid: child.pid, cdpPort, dataDir: target.dataDir, page: 'blank' };
      await page.goto(`${target.url}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.locator('[data-chat-input], [data-session-id], .h-screen').first().waitFor({ timeout: 60_000 });
      await dismissFirstRun(page, { wait: true });
    } finally {
      await browser.close().catch(() => {});
    }
    return { url: target.url, browserPid: child.pid, cdpPort, dataDir: target.dataDir };
  } catch (error) {
    // 起到一半失败：浏览器、看门狗、隔离服务都收掉，不留孤儿。
    if (partial) cleanupState(partial);
    else if (target?.slotlessDataDir) cleanupState(target);
    throw error;
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function cleanupState(state) {
  for (const pid of [state.browserPid]) {
    if (!alive(pid)) continue;
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ } }
  }
  if (state.watchdogPid && state.watchdogPid !== process.pid && alive(state.watchdogPid)) {
    try { process.kill(state.watchdogPid, 'SIGTERM'); } catch { /* 已退出 */ }
  }
  if (state.slotlessDataDir) {
    spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'verify-slotless.mjs'), '--stop', state.slotlessDataDir], { stdio: ['ignore', 2, 2] });
  }
  if (state.userDataDir?.startsWith(path.join(HOME_DIR, 'profile-'))) rmSync(state.userDataDir, { recursive: true, force: true });
  rmSync(STATE_PATH, { force: true });
}

async function browserStop() {
  const state = readState();
  if (!state) return { stopped: false, reason: '没有常驻浏览器' };
  cleanupState(state);
  return { stopped: true, browserPid: state.browserPid };
}

async function watchdogLoop() {
  // 常驻浏览器的空闲自停：每 30s 看一次 lastUsedAt；浏览器先死了也一并收尾。
  for (;;) {
    await new Promise((r) => setTimeout(r, 30_000));
    const state = readState();
    if (!state || state.watchdogPid !== process.pid) return;
    if (!alive(state.browserPid) || Date.now() - state.lastUsedAt > (state.idleExitMs ?? DEFAULT_IDLE_EXIT_MS)) {
      cleanupState(state);
      return;
    }
  }
}

async function connect(state) {
  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.cdpPort}`);
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages.find((p) => p.url().startsWith(state.url)) ?? pages[0] ?? await context.newPage();
  await page.setViewportSize(VIEWPORT).catch(() => {});
  return { browser, page };
}

// ── 页面动作 ──────────────────────────────────────────────────────────────

function locate(page, spec) {
  const t = parseTarget(spec);
  let loc;
  if (t.kind === 'testid') loc = page.getByTestId(t.value);
  else if (t.kind === 'css') loc = page.locator(t.value);
  else if (t.kind === 'role') loc = page.getByRole(t.role, t.name instanceof RegExp ? { name: t.name } : t.name ? { name: t.name, exact: true } : {});
  else loc = page.getByText(t.value);
  // 同名多个时取最后一个可见的：聊天里最新的卡片/按钮总在最后。
  return loc.filter({ visible: true }).last();
}

async function dismissFirstRun(page, { wait = false } = {}) {
  const dialogs = [
    ['这个文件夹带了自动化配置，要启用吗？', '先不启用'],
    ['初始化 Neo', '跳过，稍后在设置里配置'],
  ];
  // 首启引导约在挂载后 1.5~3s 才盖上来（firstRunDialogs.ts 记的竞态），start 时条件等一会儿，其余命令只查不等。
  const deadline = Date.now() + (wait ? 5_000 : 0);
  do {
    let any = false;
    for (const [name, button] of dialogs) {
      const dialog = page.getByRole('dialog', { name });
      if (await dialog.isVisible().catch(() => false)) {
        await dialog.getByRole('button', { name: button }).click();
        any = true;
      }
    }
    const authClose = page.getByRole('dialog').filter({ hasText: '注册' }).getByRole('button', { name: '关闭' });
    if (await authClose.isVisible().catch(() => false)) {
      await authClose.click();
      any = true;
    }
    if (any || !wait) return;
    await page.waitForTimeout(POLL_MS);
  } while (Date.now() < deadline);
}

async function sampleRun(page) {
  return page.evaluate(([running, needs, errs]) => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    return {
      t: Date.now(),
      running: running.some((sel) => [...document.querySelectorAll(sel)].some(vis)),
      // 只算还在等人操作的卡（里面有可点按钮）；已收口的卡（如「已允许 Neo 控制日历」）不算。
      cards: needs.flatMap((sel) => [...document.querySelectorAll(sel)]
        .filter((el) => vis(el) && [...el.querySelectorAll('button')].some((b) => !b.disabled && vis(b)))
        .map((el) => `${sel}|${(el.textContent || '').trim().slice(0, 200)}`)),
      errors: errs.flatMap((sel) => [...document.querySelectorAll(sel)].filter(vis).map((el) => (el.textContent || '').trim().slice(0, 300))),
    };
  }, [RUNNING_SELECTORS, NEEDS_USER_SELECTORS, ERROR_SELECTORS]);
}

async function scrollerMetrics(page, delta = 0) {
  return page.evaluate((dy) => {
    const pick = () => {
      const v = document.querySelector('[data-virtuoso-scroller]');
      if (v) return v;
      let best = null;
      for (const el of document.querySelectorAll('main *, [data-chat-input] ~ *, div')) {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4 && (!best || el.clientHeight > best.clientHeight)) best = el;
      }
      return best;
    };
    const el = pick();
    if (!el) return null;
    if (dy) el.scrollBy({ top: dy * el.clientHeight, behavior: 'instant' });
    return { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, clientHeight: el.clientHeight };
  }, delta);
}

async function probeVisibility(page, loc) {
  const handle = await loc.elementHandle({ timeout: 5_000 });
  return page.evaluate((el) => {
    const r = el.getBoundingClientRect();
    let clip = null;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if (oy === 'auto' || oy === 'scroll' || oy === 'hidden') {
        const c = p.getBoundingClientRect();
        clip = { top: c.top, bottom: c.bottom, left: c.left, right: c.right };
        break;
      }
    }
    const cx = r.left + r.width / 2;
    const describe = (n) => (n ? `${n.tagName.toLowerCase()}${n.getAttribute('data-testid') ? `[data-testid=${n.getAttribute('data-testid')}]` : ''}${n.hasAttribute('data-chat-input') ? '[data-chat-input]' : ''}${n.className && typeof n.className === 'string' ? `.${n.className.split(/\s+/).slice(0, 3).join('.')}` : ''}` : '（视口外）');
    const hits = [r.top + 1, r.top + r.height / 2, r.bottom - 1].map((y) => {
      const top = document.elementFromPoint(cx, y);
      return { ok: !!top && (el === top || el.contains(top)), by: describe(top) };
    });
    return {
      rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      clip,
      hits,
    };
  }, handle);
}

const ACTIONS = {
  async 'new-session'({ page }) {
    await page.getByRole('button', { name: '新任务' }).first().click();
    const active = page.locator('[data-session-id][aria-current="true"]').first();
    await active.waitFor({ timeout: 15_000 });
    await page.locator('[data-chat-input]').waitFor({ timeout: 15_000 });
    return { sessionId: await active.getAttribute('data-session-id') };
  },
  async 'select-model'({ page }, step) {
    const name = step.model ?? step.arg;
    if (!name) throw new Error('select-model 需要模型名（如「MiMo v2.6 Flash」）');
    const trigger = page.getByRole('button', { name: /^(切换模型|Switch model)$/ }).filter({ visible: true }).last();
    if ((await trigger.textContent())?.includes(name)) return { model: name, already: true };
    await trigger.click();
    const search = page.locator('[data-model-search-input]');
    await search.waitFor({ timeout: 10_000 });
    await search.fill(name);
    const option = page.locator('[data-model-option-index]').filter({ hasText: name }).first();
    await option.click({ timeout: 10_000 }).catch(async () => {
      await search.fill('');
      const seen = await page.locator('[data-model-option-index]').allInnerTexts();
      await page.keyboard.press('Escape');
      throw new Error(`模型列表里没有「${name}」；可选：${seen.map((t) => t.split('\n')[0]).join(' / ') || '（空）'}`);
    });
    await pollUntil(async () => (await trigger.textContent())?.includes(name), { timeoutMs: 10_000, what: `模型切到「${name}」` });
    return { model: name };
  },
  async reload(ctx) {
    // 真机 quit/launch 之后后端换了进程，页面要重新打开才会连上新服务。
    await ctx.page.goto(`${ctx.target.url}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await ctx.page.locator('[data-chat-input], [data-session-id]').first().waitFor({ timeout: 60_000 });
    await dismissFirstRun(ctx.page, { wait: true });
  },
  async 'open-session'({ page }, step) {
    const key = step.session ?? step.id ?? step.arg;
    if (!key) throw new Error('open-session 需要会话 id 或标题（场景里写 "session" 或 "id"）');
    const byId = page.locator(`[data-session-id=${JSON.stringify(key)}]`);
    const item = (await byId.count()) > 0
      ? byId.first()
      : page.locator('[data-session-id]').filter({ hasText: key }).first();
    if ((await item.count()) === 0) throw new Error(`侧栏里找不到会话「${key}」（不在已加载列表里，或已归档）`);
    const sessionId = await item.getAttribute('data-session-id');
    await item.click({ timeout: 15_000 });
    // 点击不等于切过去了：必须看到目标会话成为当前会话（aria-current），否则后续 send 会发进别的会话。
    await page.locator(`[data-session-id=${JSON.stringify(sessionId)}][aria-current="true"]`).first()
      .waitFor({ timeout: 15_000 })
      .catch(async () => {
        const current = await page.locator('[data-session-id][aria-current="true"]').first().getAttribute('data-session-id').catch(() => null);
        throw new Error(`点了会话 ${sessionId}，但当前会话是 ${current ?? '（无）'}`);
      });
    await page.locator('[data-chat-input]').waitFor({ timeout: 15_000 });
    return { sessionId };
  },
  async send(ctx, step) {
    const { page } = ctx;
    const text = step.text ?? step.arg;
    if (!text) throw new Error('send 需要文本');
    if (ctx.target.logDir) ctx.logMarks = logSizes(ctx.target.logDir);
    const input = page.locator('[data-chat-input]');
    await input.click();
    await page.keyboard.insertText(text);
    // 文字真进了输入框才回车；否则「输入框为空」会被误当成已受理。
    await pollUntil(async () => (await input.innerText().catch(() => '')).includes(text.slice(0, 20)), { timeoutMs: 5_000, what: '文字进入输入框' });
    await page.keyboard.press('Enter');
    // 受理信号：输入框清空，或出现运行中。不等 run 结束。
    await pollUntil(async () => {
      const s = await sampleRun(page);
      const plain = await input.innerText().catch(() => '');
      return s.running || !plain.trim();
    }, { timeoutMs: 15_000, what: '发送受理' });
    ctx.sentAt = Date.now();
    return { chars: text.length };
  },
  async 'wait-idle'(ctx, step) {
    const { page } = ctx;
    const base = await sampleRun(page);
    const track = createIdleTracker({ baselineCards: base.cards, baselineErrors: base.errors, seenRunning: base.running, ...(step.grace ? { startGraceMs: Number(step.grace) } : {}) });
    let verdict;
    await pollUntil(async () => {
      verdict = track(await sampleRun(page));
      return verdict.done;
    }, { timeoutMs: step.timeout ?? ctx.timeoutMs, what: '运行结束或需人卡片' });
    if (verdict.state === 'error' && step.expect !== 'error') throw new Error(`运行失败：${verdict.errors.join(' / ')}`);
    if (step.expect && step.expect !== verdict.state) throw new Error(`期望 ${step.expect}，实际 ${verdict.state}${verdict.cards ? `：${verdict.cards.join(' / ')}` : ''}`);
    return verdict;
  },
  async 'wait-text'({ page, timeoutMs }, step) {
    await locate(page, `text=${step.text ?? step.arg}`).waitFor({ timeout: step.timeout ?? timeoutMs }); // 文本可写 /正则/
  },
  async click({ page, timeoutMs }, step) {
    const loc = locate(page, step.target ?? step.arg);
    const timeout = step.timeout ?? Math.min(timeoutMs, 30_000);
    if (step.ifVisible) {
      // 清理步用：在 timeout 内没出现就跳过，不算失败。
      const shown = await loc.waitFor({ timeout }).then(() => true, () => false);
      if (!shown) return { skipped: true };
    }
    await loc.click({ timeout });
  },
  async 'assert-visible'({ page, timeoutMs }, step) {
    const loc = locate(page, step.target ?? step.arg);
    await loc.waitFor({ timeout: step.timeout ?? Math.min(timeoutMs, 30_000) });
    let last;
    // 布局可能还在收敛（虚拟列表测高/滚动跟随），在 within 内取到一次通过即算过。
    await pollUntil(async () => {
      last = visibilityVerdict(await probeVisibility(page, loc));
      return last.ok;
    }, { timeoutMs: step.within ?? 2_000, what: '元素完整可见' }).catch(() => {
      throw new Error(last?.reason ?? '元素不可见');
    });
  },
  async 'assert-bottom'({ page }, step) {
    const t0 = Date.now();
    let m;
    await pollUntil(async () => {
      m = await scrollerMetrics(page);
      return m && isAtBottom(m, step.tolerance ?? 4);
    }, { timeoutMs: step.within ?? 1_000, what: '消息列表落底' }).catch(() => {
      throw new Error(m ? `未落底：离底 ${Math.round(m.scrollHeight - m.scrollTop - m.clientHeight)}px` : '找不到消息滚动容器');
    });
    return { reachedMs: Date.now() - t0 };
  },
  async 'scroll-up'({ page }, step) {
    return scrollBy(page, -(Number(step.screens ?? step.arg) || 1));
  },
  async 'scroll-down'({ page }, step) {
    return scrollBy(page, Number(step.screens ?? step.arg) || 1);
  },
  async shot({ page }, step) {
    const dir = step.dir ?? path.join(HOME_DIR, 'shots');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${step.name ?? step.arg ?? Date.now()}.png`);
    await page.screenshot({ path: file });
    return { file };
  },
  // ── 真机 ──
  async install(ctx, step) {
    const worktree = path.resolve(step.worktree ?? step.arg ?? '');
    const script = path.join(worktree, 'scripts', 'tauri-install-dev.sh');
    if (!existsSync(script)) throw new Error(`找不到 ${script}`);
    await ACTIONS.quit(ctx, step);
    const r = spawnSync('bash', [script], { cwd: worktree, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`tauri-install-dev.sh 退出码 ${r.status}`);
  },
  async quit(ctx) {
    const { appName, port } = devApp(ctx);
    const pattern = `/Applications/${appName}.app/Contents/MacOS/`;
    const pids = () => (spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).stdout || '').split('\n').map(Number).filter(Boolean);
    const before = pids();
    // 按信号退出，不发 AppleEvent quit（会弹退出确认框，Neo 被结束后框成孤儿挂在屏幕上）。
    for (const pid of before) { try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ } }
    try {
      await pollUntil(() => pids().length === 0, { timeoutMs: 15_000, what: 'Neo 退出' });
    } catch {
      for (const pid of pids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
    }
    await pollUntil(async () => !(await healthy(port)), { timeoutMs: 10_000, what: `端口 ${port} 释放` });
    return { killed: before.length };
  },
  async launch(ctx) {
    const { appName, port } = devApp(ctx);
    const r = spawnSync('open', ['-a', `/Applications/${appName}.app`], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('open 失败');
    await pollUntil(() => healthy(port), { timeoutMs: ctx.timeoutMs, what: `${appName} 健康检查` });
  },
  async 'reset-tcc'(ctx, step) {
    const { bundleId } = devApp(ctx);
    const service = step.service ?? step.arg;
    if (!service) throw new Error('reset-tcc 需要服务名（如 Calendar、Reminders、Accessibility）');
    const r = spawnSync('tccutil', ['reset', service, bundleId], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tccutil 失败：${r.stderr}`);
    return { service, bundleId };
  },
  async 'ax-click'(ctx, step) {
    const name = step.name ?? step.arg;
    const proc = step.process ?? devApp(ctx).appName;
    const role = step.role ?? 'AXButton';
    // 按辅助功能树找元素（名称/描述 + 角色），不靠坐标。系统授权框（UserNotificationCenter）的按钮是窗口直接子元素，查询很快；
    // 应用内元素首选页面命令，WKWebView 的 AX 树要整棵遍历，慢。
    const script = `
      function run(argv) {
        const [procName, name, role, deep] = argv;
        const ps = Application('System Events').processes.whose({ name: { _contains: procName } });
        if (ps.length === 0) return 'NO_PROCESS';
        for (const w of ps[0].windows()) {
          const pool = deep === '1' ? w.entireContents() : w.buttons().concat(w.uiElements());
          for (const el of pool) {
            let r, n, d = '';
            try { r = el.role(); n = el.name(); } catch (e) { continue; }
            try { d = el.description(); } catch (e) { /* 无描述 */ }
            if (r === role && (n === name || d === name)) { el.click(); return 'CLICKED'; }
          }
        }
        return 'NOT_FOUND';
      }`;
    let out = '';
    await pollUntil(() => {
      const r = spawnSync('osascript', ['-l', 'JavaScript', '-e', script, proc, name, role, step.deep ? '1' : '0'], { encoding: 'utf8' });
      out = (r.stdout || r.stderr || '').trim();
      if (/not allowed|不允许|-1719|-25211/i.test(out)) throw new Error(`辅助功能未授权给当前终端：${out}`);
      return out === 'CLICKED';
    }, { timeoutMs: step.timeout ?? ctx.timeoutMs, intervalMs: 200, what: `${proc} 里的「${name}」` }).catch((e) => {
      throw new Error(`${e.message}（最后一次：${out}）`);
    });
    return { process: proc, name };
  },
  async 'wait-log'(ctx, step) {
    const logDir = ctx.target.logDir;
    if (!logDir) throw new Error('当前目标没有日志目录（--url 目标请加 --log-dir）');
    const re = new RegExp(step.pattern ?? step.arg);
    let marks = ctx.logMarks ?? logSizes(logDir);
    let hit;
    await pollUntil(() => {
      const r = readLogsSince(logDir, marks);
      marks = r.marks;
      hit = r.text.split('\n').find((line) => re.test(line));
      return !!hit;
    }, { timeoutMs: step.timeout ?? ctx.timeoutMs, intervalMs: 250, what: `日志 /${re.source}/` });
    ctx.logMarks = marks;
    return { line: hit.slice(0, 300) };
  },
  async 'wait-db'(ctx, step) {
    const db = path.join(ctx.target.dataDir ?? '', 'code-agent.db');
    if (!existsSync(db)) throw new Error(`找不到库 ${db}`);
    const sql = step.sql ?? step.arg;
    let out = '';
    await pollUntil(() => {
      const r = spawnSync('sqlite3', ['-readonly', db, sql], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`sqlite3 失败：${r.stderr}`);
      out = r.stdout.trim();
      return step.empty ? out === '' : out !== '';
    }, { timeoutMs: step.timeout ?? ctx.timeoutMs, intervalMs: 300, what: step.empty ? 'SQL 无结果' : 'SQL 有结果' });
    return { rows: out.split('\n').slice(0, 5) };
  },
  async 'shot-window'(ctx, step) {
    const { appName } = devApp(ctx);
    const b = spawnSync('osascript', ['-e', `tell application "System Events" to tell (first process whose name contains "${appName}" or name is "code-agent-tauri") to get {position, size} of window 1`], { encoding: 'utf8' });
    const nums = (b.stdout || '').split(/[,\s]+/).map(Number).filter((n) => !Number.isNaN(n));
    if (nums.length < 4) throw new Error(`拿不到 Neo 窗口位置：${b.stderr || b.stdout}`);
    const dir = step.dir ?? path.join(HOME_DIR, 'shots');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${step.name ?? step.arg ?? Date.now()}.png`);
    const r = spawnSync('screencapture', ['-x', `-R${nums.slice(0, 4).join(',')}`, file]);
    if (r.status !== 0) throw new Error('screencapture 失败');
    return { file };
  },
};

const NO_PAGE = new Set(['install', 'quit', 'launch', 'reset-tcc', 'ax-click', 'wait-log', 'wait-db', 'shot-window']);

async function scrollBy(page, screens) {
  const before = await scrollerMetrics(page, screens);
  if (!before) throw new Error('找不到消息滚动容器');
  // 等滚动位置稳定（虚拟列表可能补测高度），两次采样一致即停。
  let prev = -1;
  const m = await pollUntil(async () => {
    const cur = await scrollerMetrics(page);
    const same = cur.scrollTop === prev;
    prev = cur.scrollTop;
    return same ? cur : null;
  }, { timeoutMs: 3_000, intervalMs: 100, what: '滚动稳定' });
  return { scrollTop: Math.round(m.scrollTop), fromBottom: Math.round(m.scrollHeight - m.scrollTop - m.clientHeight) };
}

function devApp(ctx) {
  // 显式 --slot 优先；与常驻浏览器的槽冲突在入口已经拦掉。
  return devSlotInfo(ctx.opts.slot ?? ctx.target?.devSlot);
}

async function healthy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) });
    return r.ok;
  } catch {
    return false;
  }
}

// ── 入口 ──────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = {};
  const pos = [];
  const valued = new Set(['--model', '--url', '--timeout', '--grace', '--tolerance', '--expect', '--within', '--dir', '--process', '--role', '--slot', '--log-dir', '--idle-exit-min']);
  const camel = (k) => k.replace(/-(\w)/g, (_, c) => c.toUpperCase());
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const eq = a.match(/^--(slotless|dev)(?:=(.*))?$/);
    if (eq) opts[eq[1]] = eq[2] ?? '';
    else if (valued.has(a)) {
      if (argv[i + 1] === undefined) throw new Error(`${a} 需要值`);
      opts[camel(a.slice(2))] = argv[i + 1];
      i += 1;
    } else if (a === '--json') opts.json = true;
    else if (a === '--reuse-dist') opts.reuseDist = true;
    else if (a === '--deep') opts.deep = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`未知选项: ${a}`);
    else pos.push(a);
  }
  return { opts, pos };
}

async function withPage(state, fn) {
  const { browser, page } = await connect(state);
  try {
    await dismissFirstRun(page);
    return await fn(page);
  } finally {
    // connectOverCDP 下 close 只断开连接，常驻浏览器和页面都留着。
    await browser.close().catch(() => {});
  }
}

/** 前置检查：新会话 →（可选）切模型 → 发「你好」→ 正常回完才算环境可用；失败时 error 里是运行失败卡原文。 */
export function preflightScenario(model) {
  return {
    name: `preflight${model ? `（${model}）` : ''}`,
    ...(model ? { model } : {}),
    steps: [{ do: 'new-session' }, { do: 'send', text: '你好' }, { do: 'wait-idle', expect: 'idle', timeout: 90_000 }],
  };
}

async function runScenario(source, opts) {
  const scenario = parseScenario(typeof source === 'string' ? readFileSync(source, 'utf8') : source);
  let state = liveState();
  assertNoConflict(state, opts);
  let startedHere = false;
  if (!state && (opts.url || opts.dev !== undefined || opts.slotless !== undefined)) {
    await browserStart(opts);
    startedHere = true;
    state = liveState();
  }
  const needsPage = scenario.steps.some((s) => !NO_PAGE.has(s.do));
  if (needsPage && !state) throw new Error('场景里有页面步骤，需要先 browser start 或给 --slotless/--dev/--url');
  const target = state ?? (opts.dev !== undefined ? await resolveTarget(opts) : {});
  const t0 = Date.now();
  let conn = null;
  const ctx = { opts, target, timeoutMs: Number(opts.timeout) || DEFAULT_TIMEOUT_MS, page: null };
  try {
    const out = await runSteps(scenario.steps, async (step) => {
      if (!NO_PAGE.has(step.do) && !ctx.page) {
        conn = await connect(state);
        ctx.page = conn.page;
        await dismissFirstRun(ctx.page);
      }
      if (state) touch(state);
      try {
        return await ACTIONS[step.do](ctx, step);
      } catch (error) {
        // 失败现场自动留一张图，省得再跑一遍去看。
        if (ctx.page) await ctx.page.screenshot({ path: path.join(HOME_DIR, 'shots', `fail-${step.do}-${Date.now()}.png`) }).catch(() => {});
        throw error;
      }
    });
    return { scenario: scenario.name, ok: out.ok, totalMs: Date.now() - t0, steps: out.results };
  } finally {
    if (conn) await conn.browser.close().catch(() => {});
    if (startedHere) await browserStop();
  }
}

async function main(argv = process.argv.slice(2)) {
  const { opts, pos } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  if (opts.help || !cmd) {
    console.log(USAGE);
    return;
  }
  if (cmd === '__watchdog') return watchdogLoop();
  let result;
  if (cmd === 'browser') {
    const sub = rest[0];
    if (sub === 'start') result = await browserStart({ ...opts, idleExitMs: opts.idleExitMin ? Number(opts.idleExitMin) * 60_000 : undefined });
    else if (sub === 'stop') result = await browserStop();
    else if (sub === 'status') result = liveState() ?? { running: false };
    else throw new Error('browser start|stop|status');
  } else if (cmd === 'preflight') {
    result = await runScenario(preflightScenario(rest.join(' ') || opts.model), opts);
    process.exitCode = result.ok ? 0 : 1;
  } else if (cmd === 'run') {
    if (!rest[0]) throw new Error('run 需要场景文件');
    result = await runScenario(rest[0], opts);
    process.exitCode = result.ok ? 0 : 1;
  } else if (ACTIONS[cmd]) {
    const step = { do: cmd, arg: rest.join(' ') || undefined, expect: opts.expect, within: opts.within ? Number(opts.within) : undefined, dir: opts.dir, process: opts.process, role: opts.role, deep: opts.deep, grace: opts.grace, model: opts.model, tolerance: opts.tolerance ? Number(opts.tolerance) : undefined };
    const timeoutMs = Number(opts.timeout) || DEFAULT_TIMEOUT_MS;
    const t0 = Date.now();
    if (NO_PAGE.has(cmd)) {
      const state = liveState();
      assertNoConflict(state, opts);
      const target = state ?? (opts.dev !== undefined ? await resolveTarget(opts) : { logDir: opts.logDir ?? null, dataDir: null });
      const ctx = { opts, target, timeoutMs, logMarks: state?.logMarks };
      result = { ok: true, ms: 0, detail: await ACTIONS[cmd](ctx, step) };
      if (state) touch(state, { logMarks: ctx.logMarks });
    } else {
      const state = liveState();
      assertNoConflict(state, opts);
      if (!state) throw new Error('没有常驻浏览器：先 node scripts/neo-drive/neo-drive.mjs browser start --slotless|--dev|--url <地址>');
      const ctx = { opts, target: state, timeoutMs, logMarks: state.logMarks };
      const detail = await withPage(state, (page) => ACTIONS[cmd](Object.assign(ctx, { page }), step));
      // send 在 ctx 上记下发送前的日志偏移，留给下一条 wait-log。
      touch(state, { logMarks: ctx.logMarks });
      result = { ok: true, ms: Date.now() - t0, ...(detail === undefined ? {} : { detail }) };
    }
  } else {
    throw new Error(`未知命令: ${cmd}\n${USAGE}`);
  }
  console.log(JSON.stringify(result, null, opts.json ? 0 : 2));
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  main().catch((error) => {
    console.error(`neo-drive: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
