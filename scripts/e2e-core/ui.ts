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
export async function driveTurn(page: Page, handlers: TurnHandlers, timeoutMs: number): Promise<void> {
  const stop = page.getByTestId('composer-stop-button');
  const card = page.getByTestId('permission-card');
  const memoryTitle = page.getByText('确认用户规则');
  const deadline = Date.now() + timeoutMs;
  const startDeadline = Date.now() + TURN_START_TIMEOUT_MS;
  let sawRunning = false;
  let idle = 0;
  while (Date.now() < deadline) {
    const memoryUp = await memoryTitle.first().isVisible().catch(() => false);
    const cardUp = await card.first().isVisible().catch(() => false);
    if (memoryUp && handlers.onMemoryModal) { await handlers.onMemoryModal(page); idle = 0; continue; }
    if (cardUp && handlers.onPermissionCard) { await handlers.onPermissionCard(page); idle = 0; continue; }
    // 模型没动手而是用「需要你的回答」面板反问用户：这是模型分支，别空等到超时
    if (await page.getByText('需要你的回答', { exact: true }).first().isVisible().catch(() => false)) {
      throw new Error('模型没有继续做事，而是弹出「需要你的回答」反问用户（AskUserQuestion，模型分支）');
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

export async function clickCardButton(page: Page, label: string): Promise<void> {
  const card = page.getByTestId('permission-card').first();
  const before = await card.innerText();
  const countBefore = await page.getByTestId('permission-card').count();
  await card.getByRole('button', { name: label }).click({ timeout: 10_000 });
  // 点完这张卡应当收起（或换成下一张不同的卡）；原样还在就是「点了没反应」。快速轮询，别漏掉短暂的收起
  const deadline = Date.now() + CARD_COLLAPSE_TIMEOUT_MS;
  for (;;) {
    if (!(await card.isVisible().catch(() => false))) return;
    // 排队的两张卡文字可能一样（路径被截断），所以数量减少也算收起
    if ((await page.getByTestId('permission-card').count()) < countBefore) return;
    if ((await card.innerText().catch(() => before)) !== before) return;
    if (Date.now() > deadline) throw new Error(`点「${label}」后审批卡 ${CARD_COLLAPSE_TIMEOUT_MS / 1000} 秒内没有收起（原样还在）`);
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

/** 审批卡上的「同意」按钮：普通卡是「允许一次」，风险无法判定的命令卡是「仍然执行」。 */
export async function approveCard(page: Page): Promise<string> {
  const card = page.getByTestId('permission-card').first();
  for (const label of ['允许一次', '仍然执行']) {
    if (await card.getByRole('button', { name: label }).count()) { await clickCardButton(page, label); return label; }
  }
  throw new Error('审批卡上没有「允许一次」或「仍然执行」按钮');
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
