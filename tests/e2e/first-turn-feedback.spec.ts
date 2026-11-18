import path from 'node:path';
import { expect, test, type Route } from './fixtures/axeTest';
import { dismissFirstRunDialogs } from './firstRunDialogs';

test('排队发送只按真实事件推进发送、启动、等待模型和首 token', async ({ page, request }) => {
  const sseReady = page.waitForResponse(
    (response) => response.url().includes('/api/events'),
    { timeout: 20_000 },
  );
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await sseReady;
  await dismissFirstRunDialogs(page);
  const settingsDialog = page.getByRole('dialog', { name: '设置' });
  await settingsDialog.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
  if (await settingsDialog.isVisible().catch(() => false)) {
    await settingsDialog.getByRole('button', { name: '关闭' }).click();
    await expect(settingsDialog).toBeHidden();
  }

  await page.getByRole('button', { name: '新建快速对话' }).click();
  await settingsDialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await settingsDialog.isVisible().catch(() => false)) {
    await settingsDialog.getByRole('button', { name: '关闭' }).click();
    await expect(settingsDialog).toBeHidden();
  }
  const composer = page.locator('[data-testid="chat-composer-textarea"]');
  await expect(composer).toBeVisible({ timeout: 10_000 });
  let heldRunRoute: Route | null = null;
  let clientMessageId = '';
  await page.route('**/api/domain/settings/get', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          models: {
            default: 'openai',
            providers: {
              openai: { enabled: true, apiKey: 'e2e-placeholder', model: 'gpt-4o' },
            },
            // routing 四槽齐给（contract settings.ts 的必填槽）：设置面板会读
            // routing.memory / routing.fast（TaskStrategySettingsPanel），缺槽时模型门
            // 一打开就 TypeError 炸 ErrorBoundary。
            routing: {
              code: { provider: 'openai', model: 'gpt-4o' },
              vision: { provider: 'openai', model: 'gpt-4o' },
              fast: { provider: 'openai', model: 'gpt-4o' },
              gui: { provider: 'openai', model: 'gpt-4o' },
            },
          },
        },
      }),
    });
  });
  // #3533 后 readModelReadiness 会用会话级 getEffectiveModel 覆盖设置里的默认 provider；
  // 不 mock 它时真实 host 按全新 e2e 数据目录答 longcat（无 key），而设置 mock 里只有
  // openai，hasConfiguredRuntimeProvider 为 false，发送在模型门就被拦下，/api/run 永远不来。
  await page.route('**/api/domain/session/getEffectiveModel', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { provider: 'openai', model: 'gpt-4o', adaptive: false },
      }),
    });
  });
  await page.route('**/api/run', async (route) => {
    const payload = route.request().postDataJSON() as { clientMessageId?: string };
    clientMessageId = payload.clientMessageId ?? '';
    heldRunRoute = route;
    // 路径证据：这行出现在输出里 = 发送链真的 POST 到了 /api/run 并被本处理器截住。
    console.log(`[first-turn-feedback] POST /api/run intercepted (clientMessageId=${clientMessageId})`);
  });
  await page.route('**/api/interrupt', async (route) => {
    const payload = route.request().postDataJSON() as { clientMessageId?: string };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          outcome: 'queued',
          queuedInputId: payload.clientMessageId,
          code: 'RUN_SETTLED',
          message: 'queued by e2e route',
        },
      }),
    });
  });
  await composer.fill('验证发送后的第一帧反馈');

  const startedAt = await page.evaluate(() => performance.now());
  await composer.press('Enter');
  const placeholder = page.locator('[data-testid="assistant-send-placeholder"]');
  await expect(placeholder).toBeVisible({ timeout: 200 });
  await expect(placeholder).toHaveText('正在发送消息…');
  const elapsed = await page.evaluate((start) => performance.now() - start, startedAt);

  expect(elapsed).toBeLessThanOrEqual(200);
  await expect(page.locator('[data-testid="assistant-send-placeholder"]')).toHaveCount(1);

  const screenshotDir = process.env.NQL_SCREENSHOT_DIR;
  if (screenshotDir) {
    await page.screenshot({
      path: path.join(screenshotDir, 'N-QUEUEDRAIN-LATENCY-send-200ms.png'),
      fullPage: true,
    });
  }

  // 同步点：发送链（settings → getEffectiveModel → sendMessage → POST /api/run）真正走到
  // /api/run 处理器后才放行；裸读 heldRunRoute 会在占位 paint 与 fetch 完成之间踩竞态。
  await expect.poll(() => heldRunRoute !== null).toBe(true);
  await heldRunRoute!.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'SESSION_BUSY', message: 'session is settling' } }),
  });
  await expect(placeholder).toHaveText('已排队，正在启动…');
  await expect(page.locator('[data-testid="assistant-send-placeholder"]')).toHaveCount(1);
  if (screenshotDir) {
    await page.screenshot({
      path: path.join(screenshotDir, 'N-QUEUEDRAIN-LATENCY-queued.png'),
      fullPage: true,
    });
  }

  const token = await page.evaluate(() => (
    window as unknown as { __CODE_AGENT_TOKEN__?: string }
  ).__CODE_AGENT_TOKEN__);
  const sessionId = await page.locator('[data-session-id][aria-current="true"]').first().getAttribute('data-session-id');
  expect(token).toBeTruthy();
  expect(sessionId).toBeTruthy();
  expect(clientMessageId).toBeTruthy();
  const activationResponse = await request.post('/api/dev/emit-queued-input-activated', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      sessionId,
      id: clientMessageId,
      runId: `nql-run-${Date.now()}`,
      activatedAt: Date.now(),
    },
  });
  expect(activationResponse.ok()).toBe(true);
  await expect(placeholder).toHaveText('正在准备…');
  await expect(page.locator('[data-testid="assistant-send-placeholder"]')).toHaveCount(1);
  if (screenshotDir) {
    await page.screenshot({
      path: path.join(screenshotDir, 'N-QUEUEDRAIN-LATENCY-waiting-model.png'),
      fullPage: true,
    });
  }

  const turnId = `nff-first-token-${Date.now()}`;
  const firstToken = `首 token ${Date.now()}`;
  const response = await request.post('/api/dev/emit-agent-events', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      events: [
        { type: 'turn_start', sessionId, data: { turnId } },
        {
          type: 'message_delta',
          sessionId,
          data: {
            role: 'assistant',
            path: 'content',
            op: 'append',
            text: firstToken,
            turnId,
            messageId: turnId,
          },
        },
      ],
    },
  });
  expect(response.ok()).toBe(true);
  await expect(page.getByText(firstToken)).toBeVisible({ timeout: 10_000 });
  await expect(placeholder).toHaveCount(0);
  if (screenshotDir) {
    await page.screenshot({
      path: path.join(screenshotDir, 'N-QUEUEDRAIN-LATENCY-first-token.png'),
      fullPage: true,
    });
  }
});
