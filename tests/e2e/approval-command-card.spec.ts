import { expect, test, type APIRequestContext, type Page } from './fixtures/axeTest';
import type { AgentEvent } from '../../src/shared/contract';

// N-FIX-APPROVAL-COMMAND-CARD-DUP-EMPTY-DUMP：
// 1. bash 命令卡命令正文只展示一次（不再叠 preview.summary 与 argsPreview）。
// 2. spawn_agent 审批卡展示通用标题「需要你确认」与「派出子代理（角色）：任务摘要」，不再是空壳「执行工具 spawn_agent」。
// 3. 超 8 行 / 400 字符的长脚本默认折叠前 8 行并展示「共 N 行，仅展示前 8 行 · 展开全部」。

type RendererAgentEvent = AgentEvent & { sessionId?: string };

const BASH_COMMAND = 'curl -sL https://example.com/feed.xml | head -n 20';
const LONG_SCRIPT = Array.from({ length: 42 }, (_, idx) => `echo "step-${idx + 1}-output"`).join('\n');

test.setTimeout(90_000);
test.use({ viewport: { width: 1440, height: 900 } });

async function acquireToken(request: APIRequestContext): Promise<string> {
  const index = await request.get('/');
  expect(index.ok(), `GET / failed: ${index.status()}`).toBe(true);
  const match = /window\.__CODE_AGENT_TOKEN__=("(?:[^"\\]|\\.)*")/.exec(await index.text());
  expect(match, '__CODE_AGENT_TOKEN__ missing from index.html').toBeTruthy();
  return JSON.parse(match![1]) as string;
}

async function emitAgentEvents(
  request: APIRequestContext,
  token: string,
  events: RendererAgentEvent[],
): Promise<void> {
  const response = await request.post('/api/dev/emit-agent-events', {
    data: { events },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(
    response.ok(),
    `emit-agent-events failed: ${response.status()} ${await response.text()}`,
  ).toBe(true);
}

async function switchUiLanguage(
  request: APIRequestContext,
  token: string,
  language: 'zh' | 'en',
): Promise<void> {
  const current = await request.get('/api/settings', { headers: { Authorization: `Bearer ${token}` } });
  expect(current.ok(), `GET /api/settings failed: ${current.status()}`).toBe(true);
  const settings = (await current.json()) as { ui?: Record<string, unknown> };
  const updated = await request.put('/api/settings', {
    data: { ...settings, ui: { ...(settings.ui ?? {}), language } },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(updated.ok(), `PUT /api/settings failed: ${updated.status()} ${await updated.text()}`).toBe(true);
}

async function clearSessions(request: APIRequestContext, token: string): Promise<void> {
  const list = await request.get('/api/sessions', { headers: { Authorization: `Bearer ${token}` } });
  expect(list.ok(), `GET /api/sessions failed: ${list.status()}`).toBe(true);
  const body = (await list.json()) as { data?: Array<{ id?: string }> };
  for (const session of body.data ?? []) {
    if (typeof session.id !== 'string') continue;
    const removed = await request.delete(`/api/sessions/${session.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(removed.ok(), `DELETE /api/sessions/${session.id} failed: ${removed.status()}`).toBe(true);
  }
}

async function dismissOnboarding(page: Page, skipLabel: string): Promise<void> {
  const onboarding = page.getByRole('dialog', { name: '初始化 Neo' });
  await onboarding.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  if (await onboarding.isVisible().catch(() => false)) {
    await onboarding.getByRole('button', { name: skipLabel }).click();
  }
}

async function createCleanSession(page: Page): Promise<string> {
  const newTask = page.getByTestId('sidebar-new-task');
  await expect(newTask).toBeVisible({ timeout: 15_000 });
  await newTask.click();
  const activeSession = page.locator('[data-session-id][aria-current="true"]').first();
  await expect(activeSession).toBeVisible({ timeout: 15_000 });
  const sessionId = await activeSession.getAttribute('data-session-id');
  expect(sessionId, 'active session id missing').toBeTruthy();
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });
  return sessionId!;
}

async function prepareSession(page: Page, request: APIRequestContext): Promise<{ token: string; sessionId: string }> {
  const token = await acquireToken(request);
  await switchUiLanguage(request, token, 'zh');
  await clearSessions(request, token);
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await dismissOnboarding(page, '跳过，稍后在设置里配置');
  const backToApp = page.getByRole('button', { name: '返回应用' });
  await backToApp.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await backToApp.isVisible().catch(() => false)) {
    await backToApp.click();
    await expect(backToApp).toBeHidden({ timeout: 10_000 });
  }
  const sessionId = await createCleanSession(page);
  return { token, sessionId };
}

test('bash 命令审批卡：命令文本只渲染一次', async ({ page, request }, testInfo) => {
  const { token, sessionId } = await prepareSession(page, request);
  const turnId = `bash-card-${Date.now()}`;
  const requestId = `bash-card-req-${Date.now()}`;

  await emitAgentEvents(request, token, [
    { type: 'turn_start', sessionId, data: { turnId } },
    { type: 'stream_chunk', sessionId, data: { turnId, content: '正在拉取站点订阅源。' } },
    {
      type: 'permission_request',
      sessionId: 'global',
      data: {
        id: requestId,
        sessionId,
        forceConfirm: true,
        type: 'command',
        tool: 'Bash',
        argsPreview: BASH_COMMAND,
        details: {
          command: BASH_COMMAND,
          preview: {
            type: 'command',
            summary: BASH_COMMAND,
          },
        },
        timestamp: Date.now(),
      },
    },
  ]);

  const permissionCard = page.getByTestId('permission-card');
  await expect(permissionCard).toBeVisible({ timeout: 15_000 });
  await expect(permissionCard).toContainText(BASH_COMMAND, { timeout: 15_000 });
  await emitAgentEvents(request, token, [
    { type: 'stream_chunk', sessionId, data: { turnId, content: '等待确认。' } },
  ]);
  const textContent = (await permissionCard.textContent()) ?? '';
  expect(textContent.split(BASH_COMMAND).length - 1).toBe(1);

  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  await page.screenshot({
    path: testInfo.outputPath('approval-card-bash.png'),
    animations: 'disabled',
    fullPage: true,
  });
});

test('spawn_agent 审批卡：显示通用确认标题与子代理角色+任务摘要', async ({ page, request }, testInfo) => {
  const { token, sessionId } = await prepareSession(page, request);
  const turnId = `spawn-card-${Date.now()}`;
  const requestId = `spawn-card-req-${Date.now()}`;
  const summaryText = '派出子代理（数据分析师）：汇总本周销售日报并输出关键异常指标';

  await emitAgentEvents(request, token, [
    { type: 'turn_start', sessionId, data: { turnId } },
    { type: 'stream_chunk', sessionId, data: { turnId, content: '正在准备派出子代理分析数据。' } },
    {
      type: 'permission_request',
      sessionId: 'global',
      data: {
        id: requestId,
        sessionId,
        forceConfirm: true,
        type: 'command',
        tool: 'spawn_agent',
        details: {
          preview: {
            type: 'generic',
            summary: summaryText,
          },
        },
        timestamp: Date.now(),
      },
    },
  ]);

  const permissionCard = page.getByTestId('permission-card');
  await expect(permissionCard).toBeVisible({ timeout: 15_000 });
  await expect(permissionCard).toContainText('需要你确认', { timeout: 15_000 });
  await expect(permissionCard).toContainText(summaryText, { timeout: 15_000 });
  await emitAgentEvents(request, token, [
    { type: 'stream_chunk', sessionId, data: { turnId, content: '等待确认。' } },
  ]);

  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  await page.screenshot({
    path: testInfo.outputPath('approval-card-spawn-agent.png'),
    animations: 'disabled',
    fullPage: true,
  });
});

test('42 行长脚本审批卡：默认折叠前 8 行并提供展开全部按钮', async ({ page, request }, testInfo) => {
  const { token, sessionId } = await prepareSession(page, request);
  const turnId = `long-script-card-${Date.now()}`;
  const requestId = `long-script-req-${Date.now()}`;

  await emitAgentEvents(request, token, [
    { type: 'turn_start', sessionId, data: { turnId } },
    { type: 'stream_chunk', sessionId, data: { turnId, content: '准备运行批量检查脚本。' } },
    {
      type: 'permission_request',
      sessionId: 'global',
      data: {
        id: requestId,
        sessionId,
        forceConfirm: true,
        type: 'command',
        tool: 'Bash',
        details: {
          command: LONG_SCRIPT,
          preview: {
            type: 'command',
            summary: LONG_SCRIPT.slice(0, 200),
          },
        },
        timestamp: Date.now(),
      },
    },
  ]);

  const permissionCard = page.getByTestId('permission-card');
  await expect(permissionCard).toBeVisible({ timeout: 15_000 });
  await expect(permissionCard).toContainText('共 42 行，仅展示前 8 行', { timeout: 15_000 });
  await expect(permissionCard).toContainText('step-8-output', { timeout: 15_000 });
  await expect(permissionCard).not.toContainText('step-9-output');
  await emitAgentEvents(request, token, [
    { type: 'stream_chunk', sessionId, data: { turnId, content: '等待确认。' } },
  ]);

  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  await page.screenshot({
    path: testInfo.outputPath('approval-card-long-script.png'),
    animations: 'disabled',
    fullPage: true,
  });
});
