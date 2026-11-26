import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';

const POLL_MS = 500;
const TURN_START_TIMEOUT_MS = 45_000;
const IDLE_POLLS = 4;
const CARD_COLLAPSE_TIMEOUT_MS = 30_000;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）：${what}`);
    await sleep(POLL_MS);
  }
}

/** 点掉首启弹层（引导 / 文件夹信任 / 网页版注册提示），否则它们会盖住聊天界面。 */
export async function dismissFirstRunLayers(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await sleep(700);
    const skip = page.getByRole('button', { name: '跳过，稍后在设置里配置' });
    const notNow = page.getByRole('button', { name: '先不启用' });
    const close = page.getByRole('button', { name: '关闭', exact: true });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    else if (await notNow.isVisible().catch(() => false)) await notNow.click();
    else if (await page.getByText('注册').first().isVisible().catch(() => false)
      && await close.isVisible().catch(() => false)) await close.click();
  }
}

export async function openNewSession(page: Page): Promise<string> {
  await page.getByTestId('sidebar-new-task').click();
  await sleep(800);
  return activeSessionId(page);
}

export async function activeSessionId(page: Page): Promise<string> {
  const loc = page.locator('[data-session-id][aria-current="true"]').first();
  const ok = await loc.waitFor({ state: 'attached', timeout: 15_000 }).then(() => true, () => false);
  return ok ? (await loc.getAttribute('data-session-id')) ?? '' : '';
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  const box = page.getByTestId('chat-composer-textarea');
  await box.waitFor({ state: 'visible', timeout: 20_000 });
  await box.fill(text);
  await box.press('Enter');
}

export interface TurnHandlers {
  /** 出现审批卡时调用；不传则不动它（卡会一直等到 60 秒超时）。 */
  onPermissionCard?: (page: Page) => Promise<void>;
  /** 出现「确认用户规则」弹窗时调用。 */
  onMemoryModal?: (page: Page) => Promise<void>;
  /** 返回 true 就提前结束等待（例如后台面板已出现任务）。 */
  until?: () => Promise<boolean>;
  /** 调用时回合可能早已收尾（只是接着看有没有迟到的审批卡）：一直没看到运行中也不算错。 */
  mayBeIdle?: boolean;
}

/** 轮询驱动一轮对话直到回合收尾：遇到审批卡 / 记忆弹窗就交给 handler。 */
const STALL_MS = 75_000;
let stallRecovery: (() => Promise<void>) | null = null;
/** 页面 75 秒毫无变化时的补救（刷新页面重新载入会话），每次 driveTurn 最多一次；由 run.ts 按尝试设置。 */
export function setStallRecovery(fn: (() => Promise<void>) | null): void { stallRecovery = fn; }

export async function driveTurn(page: Page, handlers: TurnHandlers, timeoutMs: number): Promise<void> {
  const stop = page.getByTestId('composer-stop-button');
  const card = page.getByTestId('permission-card');
  const memoryTitle = page.getByText('确认用户规则');
  const deadline = Date.now() + timeoutMs;
  const startDeadline = Date.now() + TURN_START_TIMEOUT_MS;
  let sawRunning = false;
  let idle = 0;
  let lastText = '';
  let lastChange = Date.now();
  let recovered = false;
  while (Date.now() < deadline) {
    const text = await pageText(page).catch(() => lastText);
    if (text !== lastText) { lastText = text; lastChange = Date.now(); }
    if (!recovered && stallRecovery && Date.now() - lastChange > STALL_MS) {
      recovered = true;
      await stallRecovery();
      lastChange = Date.now();
    }
    const memoryUp = await memoryTitle.first().isVisible().catch(() => false);
    const cardUp = await card.first().isVisible().catch(() => false);
    if (memoryUp && handlers.onMemoryModal) { await handlers.onMemoryModal(page); idle = 0; continue; }
    if (cardUp && handlers.onPermissionCard) { await handlers.onPermissionCard(page); idle = 0; continue; }
    // 模型没动手而是用「需要你的回答」面板反问用户：这是模型分支，别空等到超时
    if (await page.getByText('需要你的回答', { exact: true }).first().isVisible().catch(() => false)) {
      throw new Error('模型没有继续做事，而是弹出「需要你的回答」反问用户（AskUserQuestion，模型分支）');
    }
    // 面板没渲染出来时只剩这句状态：AskUserQuestion 在等用户（SSE 里是 tool_progress 一直涨），同样是模型分支
    if ((await pageText(page).catch(() => '')).includes('正在等待你的回答')) {
      await sleep(3_000);
      if ((await pageText(page).catch(() => '')).includes('正在等待你的回答')) throw new Error('模型调用了 AskUserQuestion 在等用户回答（页面只显示「正在等待你的回答」，模型分支）');
    }
    if (handlers.until && await handlers.until().catch(() => false)) return;
    // 前台停止键或后台任务的停止键任一在，就还没收尾（后台任务里的审批卡也会在这段时间冒出来）
    const running = (await stop.count().catch(() => 0)) > 0
      || await page.getByTestId('background-session-stop').first().isVisible().catch(() => false);
    if (running || memoryUp || cardUp) { sawRunning = true; idle = 0; }
    else if ((sawRunning || handlers.mayBeIdle) && ++idle >= IDLE_POLLS) return;
    else if (!sawRunning && Date.now() > startDeadline) throw new Error('发送后回合没有开始（没看到停止键）');
    await sleep(POLL_MS);
  }
  throw new Error(`等待回合收尾超时（${Math.round(timeoutMs / 1000)}s）`);
}

type DeliveryProbe = (sinceMs: number) => Promise<boolean>;
let deliveryProbe: DeliveryProbe | null = null;
/** 排队的几张卡文字可能完全一样、界面上看不出换了一张：超时后用数据库里「点击之后有没有新的审批决定」判断点击是否送达。 */
export function setDeliveryProbe(probe: DeliveryProbe | null): void { deliveryProbe = probe; }

export class RealHomeWriteError extends Error {
  constructor(dir: string) { super(`审批卡指向真实主目录 ${dir}，已拒绝，没有批准（模型分支）`); }
}

// 普通卡和高危卡的两个按钮是「允许 / 暂不」；沙盒拦截卡仍是「允许仅这一次 / 拒绝」。
const DENY_LABELS = ['暂不', '拒绝'];
const EXPAND_LABEL = '更多选项与详情';
type CardLocator = ReturnType<Page['getByTestId']>;

/** 卡面的「允许」「暂不」要整词匹配：展开后还有「本次任务内允许」「24 小时内允许」，按子串找会一次命中多个。 */
function cardButton(card: CardLocator, label: string): ReturnType<CardLocator['getByRole']> {
  return card.getByRole('button', { name: label, exact: label === '允许' || label === '暂不' });
}

/**
 * 审批卡默认只露一句话和两个按钮，命令、路径和限时授权都收在「更多选项与详情」里。
 * 读卡上的命令/路径、点限时授权之前先展开；已展开或这张卡没有折叠区时什么都不做。
 */
export async function expandCard(page: Page): Promise<void> {
  const more = page.getByTestId('permission-card').first().getByRole('button', { name: EXPAND_LABEL, exact: true });
  if (await more.count()) await more.click({ timeout: 10_000 });
}

/** 审批卡上的「不同意」按钮。 */
export async function denyCard(page: Page): Promise<string> {
  const card = page.getByTestId('permission-card').first();
  for (const label of DENY_LABELS) {
    if (await cardButton(card, label).count()) { await clickCardButton(page, label); return label; }
  }
  throw new Error('审批卡上没有「暂不」/「拒绝」按钮');
}

/** 这台机器真实的数据目录（不是 neo-realrun 的隔离 HOME）。模型会从路径里的用户名猜出它。 */
export const realDataDir = (): string => path.join(os.homedir(), '.code-agent');

/**
 * 所有「同意」点击的唯一出口都过这道护栏：卡片正文指向真实主目录的写入，一律改点「拒绝」并抛错，
 * 不管是哪条流程、哪个会话（F14 第二个会话读写记忆文件的卡也走这里）。
 */
export async function clickCardButton(page: Page, label: string): Promise<void> {
  const card = page.getByTestId('permission-card').first();
  // 护栏要读到路径和命令，它们在折叠区里：不展开就读，等于没检查。
  await expandCard(page);
  const before = await card.innerText();
  if (!DENY_LABELS.includes(label) && before.includes(realDataDir())) {
    for (const deny of DENY_LABELS) {
      if (await cardButton(card, deny).count()) { await cardButton(card, deny).click({ timeout: 10_000 }); break; }
    }
    throw new RealHomeWriteError(realDataDir());
  }
  const countBefore = await page.getByTestId('permission-card').count();
  const clickedAt = Date.now();
  await cardButton(card, label).click({ timeout: 10_000 });
  // 点完这张卡应当收起（或换成下一张不同的卡）；原样还在就是「点了没反应」。快速轮询，别漏掉短暂的收起
  const deadline = Date.now() + CARD_COLLAPSE_TIMEOUT_MS;
  for (;;) {
    if (!(await card.isVisible().catch(() => false))) return;
    // 排队的两张卡文字可能一样（路径被截断），所以数量减少也算收起
    if ((await page.getByTestId('permission-card').count()) < countBefore) return;
    if ((await card.innerText().catch(() => before)) !== before) return;
    if (Date.now() > deadline) {
      if (deliveryProbe && await deliveryProbe(clickedAt).catch(() => false)) return;
      throw new Error(`点「${label}」后审批卡 ${CARD_COLLAPSE_TIMEOUT_MS / 1000} 秒内没有收起（原样还在，数据库里也没有新的审批决定）`);
    }
    await sleep(100);
  }
}

export async function pageText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

/**
 * 网页版没有原生选文件夹框，新任务的文件夹是服务自己建的空目录。像用户把项目文件夹交给 Neo 那样：
 * 先以共享工作目录建会话（POST /api/sessions），再在侧栏里点开它。
 */
export async function openFolderSession(env: { page: Page; server: { port: number; token: string; workspace: string } }, title: string): Promise<string> {
  const { page, server } = env;
  const origin = `http://127.0.0.1:${server.port}`;
  const res = await fetch(`${origin}/api/sessions`, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, workingDirectory: server.workspace }),
  });
  const body = await res.json() as { success?: boolean; data?: { id?: string } };
  const id = body.data?.id;
  if (!res.ok || !id) throw new Error(`建会话失败：HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  await page.goto(`${origin}/`);
  await page.getByTestId('sidebar-new-task').waitFor({ timeout: 30_000 });
  await dismissFirstRunLayers(page);
  const item = page.locator(`[data-session-id="${id}"]`).first();
  await item.waitFor({ state: 'visible', timeout: 20_000 });
  await item.click();
  await page.locator(`[data-session-id="${id}"][aria-current="true"]`).first().waitFor({ timeout: 15_000 });
  return id;
}

/** 审批卡上的「同意」按钮：普通卡和高危卡是「允许」，沙盒拦截卡是「允许仅这一次」，写回卡等专用卡仍是「允许一次」。 */
export async function approveCard(page: Page): Promise<string> {
  const card = page.getByTestId('permission-card').first();
  for (const label of ['允许', '允许仅这一次', '允许一次']) {
    if (await cardButton(card, label).count()) { await clickCardButton(page, label); return label; }
  }
  throw new Error('审批卡上没有「允许」/「允许仅这一次」/「允许一次」按钮');
}

/**
 * 右侧「任务」栏里的「后台任务」小节（模型走 delegate_task 时出现）没有 testid，按它的可见文字读：
 * 「后台任务 <条数> 后台 <状态> <名字>」。右栏可能正显示别的标签（产出文件预览），先点回「任务」标签。
 */
export async function backgroundTaskRow(page: Page): Promise<{ status: string; title: string } | null> {
  // 标签的角色不固定（tab / button / 纯文字），按可见顺序试
  for (const tab of [page.getByRole('tab', { name: '任务', exact: true }), page.getByRole('button', { name: '任务', exact: true }), page.getByText('任务', { exact: true })]) {
    if (await tab.first().isVisible().catch(() => false)) { await tab.first().click({ timeout: 3_000 }).catch(() => {}); break; }
  }
  await sleep(300);
  const text = await pageText(page);
  const m = /后台任务\s+\d+\s+后台\s+(进行中|完成|失败|已完成|已中断)\s+(\S[^\n]*)/.exec(text);
  return m ? { status: m[1], title: m[2].trim() } : null;
}

/** 前台回合收尾后，转后台的任务可能还在跑（审批卡也会在这时冒出来）：处理卡片，等到右栏「后台任务」不再是「进行中」。 */
export async function settleBackground(page: Page, onCard: (page: Page) => Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let calm = 0;
  while (Date.now() < deadline) {
    if (await page.getByTestId('permission-card').first().isVisible().catch(() => false)) { await onCard(page); calm = 0; continue; }
    const row = await backgroundTaskRow(page);
    if (row?.status === '进行中') calm = 0;
    else if (++calm >= 3) return;
    await sleep(POLL_MS);
  }
  throw new Error(`等待后台任务收尾超时（${Math.round(timeoutMs / 1000)}s）`);
}
