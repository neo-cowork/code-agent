import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from './fixtures/axeTest';
import type { AgentEvent } from '../../src/shared/contract';

// N-FIX-APPROVAL-BAR-COLLAPSED-HIDES-ACTION-REDO：
// 多步任务排队 3 项审批（mail_draft + reminders_create + calendar_create_event），
// 审批卡面必须直接显示「动作 + 对象」一句话与「还有 2 项」/「2 more」，不落回无内容兜底句。

type RendererAgentEvent = AgentEvent & { sessionId?: string };

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
  const onboarding = page.getByRole('dialog', { name: /初始化 Neo|Set up Neo/i });
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

for (const language of ['zh', 'en'] as const) {
  const copy = {
    zh: {
      skipButton: '跳过，稍后在设置里配置',
      expectedQuestion: '保存邮件草稿「本周进度同步」？',
      expectedRemaining: '还有 2 项',
      fallback1: '允许这次操作？',
      fallback2: '允许进行以下操作？',
    },
    en: {
      skipButton: 'Skip for now, set up later in Settings',
      expectedQuestion: 'Save an email draft “本周进度同步”?',
      expectedRemaining: '2 more',
      fallback1: 'Allow this operation?',
      fallback2: 'Allow the following operation?',
    },
  }[language];

  test(`审批卡一句话摘要与排队计数 · ${language}`, async ({ page, request }, testInfo) => {
    const token = await acquireToken(request);
    await switchUiLanguage(request, token, language);
    await clearSessions(request, token);
    await page.goto('/');
    await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
    await dismissOnboarding(page, copy.skipButton);
    const backToApp = page.getByRole('button', { name: /返回应用|Back to app/i });
    await backToApp.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (await backToApp.isVisible().catch(() => false)) {
      await backToApp.click();
      await expect(backToApp).toBeHidden({ timeout: 10_000 });
    }

    const sessionId = await createCleanSession(page);
    const now = Date.now();
    const turnId = `compact-bar-${language}-${now}`;
    await emitAgentEvents(request, token, [
      { type: 'turn_start', sessionId, data: { turnId } },
      {
        type: 'stream_chunk',
        sessionId,
        data: { turnId, content: '正在准备保存邮件草稿、创建提醒与日程。' },
      },
      {
        type: 'permission_request',
        sessionId: 'global',
        data: {
          id: `perm-mail-draft-${language}-${now}`,
          sessionId,
          tool: 'mail_draft',
          type: 'command',
          details: {
            to: ['alice@example.com'],
            subject: '本周进度同步',
            content: '附件是本周进度',
          },
          timestamp: now,
        },
      },
      {
        type: 'permission_request',
        sessionId: 'global',
        data: {
          id: `perm-feishu-write-${language}-${now + 1}`,
          sessionId,
          tool: 'mcp__lark__calendar_v4_calendarEvent_create',
          type: 'command',
          details: {},
          argsPreview: '周会同步 · 10:00-11:00',
          timestamp: now + 1,
        },
      },
      {
        type: 'permission_request',
        sessionId: 'global',
        data: {
          id: `perm-mail-draft-2-${language}-${now + 2}`,
          sessionId,
          tool: 'mail_draft',
          type: 'command',
          details: {
            to: ['bob@example.com'],
            subject: '产品评审纪要',
          },
          timestamp: now + 2,
        },
      },
    ]);

    const card = page.getByTestId('permission-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText(copy.expectedQuestion, { timeout: 15_000 });
    await expect(card).toContainText(copy.expectedRemaining, { timeout: 15_000 });
    await expect(card).not.toContainText(copy.fallback1);
    await expect(card).not.toContainText(copy.fallback2);
    await expect(card).not.toContainText('mail_draft');

    const shotDir = process.env.COMPACT_BAR_SHOT_DIR;
    const shotPath = shotDir
      ? path.join(shotDir, `compact-bar-${language}.png`)
      : testInfo.outputPath(`compact-bar-${language}.png`);
    await page.screenshot({ path: shotPath, fullPage: false });
  });
}
