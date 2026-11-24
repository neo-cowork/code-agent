// ============================================================================
// E2E PoC: new-session flow
// ============================================================================
//
// 目标: 验证创建会话的完整 wiring 路径
//   click 新会话 → domain:session create handler → SessionManager
//   → DB write → renderer sessionStore → DOM [data-current-session-id]
//
// 拦截能力:
//   - 拦 wiring bug #1 (aebaa4e0 session flush via activeAgentLoops) 的前置
//   - 拦 wiring bug #2 (e30c90ce auth token 失效路径) 的基础 (SSE 订阅 + token 注入)
//
// PoC 期间的真实发现 (见 docs/audits/e2e-strategy.md §7 "PoC 期间发现"):
//   SessionManager.createSession() 漏调 notifySessionListUpdated() 时,
//   REST 路径建的 session 不经 SSE 通知到 renderer。这里保留 REST 注入回归,
//   避免 UI click 的 optimistic state 掩盖写入端通知缺口。
//
// 见 docs/audits/e2e-strategy.md §3 Flow A.
// ============================================================================

import { test, expect, type Page } from './fixtures/axeTest';

test.setTimeout(30_000);

async function waitForAppReady(page: Page): Promise<void> {
  // SSE 连接在 goto 之前挂监听, 避免错过初始请求
  const ssePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/events'),
    { timeout: 20_000 },
  );
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;
}

async function getAuthToken(page: Page): Promise<string> {
  const token = await page.evaluate(() =>
    (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ as string | undefined,
  );
  expect(
    token,
    'window.__CODE_AGENT_TOKEN__ missing — static.ts token injection broke',
  ).toBeTruthy();
  return token!;
}

async function ensureActiveSession(page: Page): Promise<string> {
  const activeSession = page.locator('[data-current-session-id]').first();
  if (!(await activeSession.isVisible())) {
    const newSessionBtn = page.getByRole('button', { name: '新任务' });
    await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });
    await newSessionBtn.click();
  }
  await expect(activeSession).toBeVisible({ timeout: 10_000 });
  const sessionId = await activeSession.getAttribute('data-current-session-id');
  expect(sessionId, 'active session id missing after creating probe session').toBeTruthy();
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });
  return sessionId!;
}

// ----------------------------------------------------------------------------
// Test 1: 点击「新会话」按钮 → 出现 active session + chat 输入框可见
// 验证: click → domain:session create → SessionManager → renderer store → DOM
// ----------------------------------------------------------------------------
test('PoC: 点击新会话按钮, 出现 active session 和 chat 输入框', async ({ page }) => {
  await waitForAppReady(page);

  const newSessionBtn = page.getByRole('button', { name: '新任务' });
  await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });
  await newSessionBtn.click();

  const activeSession = page.locator('[data-current-session-id]').first();
  await expect(activeSession).toBeVisible({ timeout: 10_000 });

  const sessionId = await activeSession.getAttribute('data-current-session-id');
  expect(sessionId, 'active session id missing after click').toBeTruthy();

  // ChatView 已挂到新 session
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });
});

test('PoC: 新会话空 composer 输入 slash 能打开统一 picker', async ({ page }) => {
  await waitForAppReady(page);

  const newSessionBtn = page.getByRole('button', { name: '新任务' });
  await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });
  await newSessionBtn.click();

  const input = page.locator('[data-chat-input]');
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill('/');

  const picker = page.locator('[data-slash-command-popover]');
  await expect(picker).toBeVisible({ timeout: 10_000 });
  await expect(picker.locator('[data-slash-command-id="new"]')).toBeVisible();
  await expect(picker.locator('[data-slash-command-id="agent"]')).toBeVisible();
  await expect(picker.locator('[data-slash-command-id="workflow"]')).toBeVisible();
});

// ----------------------------------------------------------------------------
// Test 2: window 注入的 auth token 存在 + SSE 通道存活
// 验证: SSE 订阅基础设施 + token 注入链路 (拦 wiring bug #2 前置)
// ----------------------------------------------------------------------------
test('PoC: 应用 ready 后 token 已注入, SSE 通道接收 dev 事件', async ({ page, request }) => {
  await waitForAppReady(page);

  const token = await getAuthToken(page);
  const sessionId = await ensureActiveSession(page);
  const base = Date.now();
  const runId = `e2e-probe-run-${base}`;
  const treeId = `e2e-probe-tree-${base}`;

  // 用合法 token 发 dev hook, 期望 200 (说明 SSE 通道 + auth middleware 工作)
  const probeResp = await request.post('/api/dev/emit-swarm-event', {
    data: {
      type: 'swarm:started',
      sessionId,
      runId,
      treeId,
      timestamp: base,
      data: {
        statistics: {
          total: 0,
          completed: 0,
          failed: 0,
          running: 0,
          pending: 0,
          parallelPeak: 0,
          totalTokens: 0,
          totalToolCalls: 0,
        },
      },
    },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(
    probeResp.ok(),
    `SSE backplane probe failed: ${probeResp.status()} ${await probeResp.text()}`,
  ).toBe(true);

  // 用错 token 发同样请求, 期望 401/403 (说明 auth middleware 真在守门)
  const badResp = await request.post('/api/dev/emit-swarm-event', {
    data: {
      type: 'swarm:started',
      sessionId,
      runId,
      treeId,
      timestamp: base + 1,
      data: {
        statistics: {
          total: 0,
          completed: 0,
          failed: 0,
          running: 0,
          pending: 0,
          parallelPeak: 0,
          totalTokens: 0,
          totalToolCalls: 0,
        },
      },
    },
    headers: { Authorization: `Bearer this-is-not-a-real-token-${Date.now()}` },
  });
  expect(badResp.status(), 'auth middleware should reject invalid token').toBeGreaterThanOrEqual(401);
  expect(badResp.status(), 'auth middleware should reject invalid token').toBeLessThanOrEqual(403);
});

// ----------------------------------------------------------------------------
// Test 3: 点击「新任务」后, 空白新会话是当前会话但没有侧栏行；发出第一条消息后行才出现
// 验证: 侧栏只列有内容的会话（blank 占位会话不进列表），且空白会话仍可选中、可发送
// ----------------------------------------------------------------------------
test('PoC: 空白新会话是当前会话但无侧栏行，有消息后才出现', async ({ page }) => {
  await waitForAppReady(page);

  const newSessionBtn = page.getByRole('button', { name: '新任务' });
  await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });
  await newSessionBtn.click();

  const activeSession = page.locator('[data-current-session-id]').first();
  await expect(activeSession).toBeVisible({ timeout: 10_000 });
  const sessionId = await activeSession.getAttribute('data-current-session-id');
  expect(sessionId).toBeTruthy();
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });

  // 空白占位会话不进侧栏
  await expect(page.locator(`[data-session-id="${sessionId}"]`)).toHaveCount(0);

  // 在这个当前会话里落一条消息（e2e 环境没配模型，走 dev seed 通道写库），重载后行出现
  const token = await getAuthToken(page);
  const seed = await page.request.post(`/api/dev/seed-messages?token=${encodeURIComponent(token)}`, {
    data: {
      sessionId,
      messages: [{ id: `ns-${Date.now()}`, role: 'user', content: '把这三行笔记总结成一句话', timestamp: Date.now() }],
    },
  });
  expect(seed.status(), await seed.text()).toBe(200);
  await waitForAppReady(page);
  await expect(page.locator(`[data-session-id="${sessionId}"]`).first()).toBeVisible({ timeout: 10_000 });
});

// ----------------------------------------------------------------------------
// Test 4: REST 创建 session → SessionManager 通知 → SSE → renderer loadSessions
// 验证: 非 UI 路径创建 session 后, 页面不 reload 也能看到新 session
// ----------------------------------------------------------------------------
test('PoC: REST 创建 session 后经 SSE 出现在侧边栏', async ({ page, request }) => {
  await waitForAppReady(page);

  const token = await getAuthToken(page);
  const title = `REST SSE Session ${Date.now()}`;
  const response = await request.post('/api/sessions', {
    data: { title },
    headers: { Authorization: `Bearer ${token}` },
  });

  expect(
    response.ok(),
    `POST /api/sessions failed: ${response.status()} ${await response.text()}`,
  ).toBe(true);

  const body = await response.json() as { success: boolean; data?: { id?: string } };
  expect(body.success).toBe(true);
  expect(body.data?.id, 'created session id missing').toBeTruthy();

  const sidebarItem = page.locator(`[data-session-id="${body.data!.id}"]`).first();
  await expect(sidebarItem).toBeVisible({ timeout: 10_000 });
});
