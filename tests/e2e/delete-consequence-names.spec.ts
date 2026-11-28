import { expect, test, type APIRequestContext, type Page } from './fixtures/axeTest';
import type { AgentEvent } from '../../src/shared/contract';

// N-FIX-APPROVAL-CARD-DELETE-CONSEQUENCE-NAMES-ONLY-FIRST-FILE（FB-1618）：删除审批卡的
// 后果行对多目标 rm 点名前 3 个目标并写「等 N 个」，混了通配符的命令一个名字都不写，
// 单文件删除保持原句。zh/en 各走一遍真实 web 构建（非视觉基线比对），截图前先在页面里
// 断言 [data-testid="permission-consequence"] 的文本。
//
// 请求形状照宿主对 rm -rf 的真实下发：affectedPath 只是第一个目标、affectedFileCount 是
// 全部目标之和（src/host/tools/deleteImpact.ts）；通配符命令没有 affectedFileCount。
// 语言在首载前 PUT /api/settings 写入（加载后 reload 会与新会话 switchSession 竞争）。

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

/** 「初始化 Neo」跳过不落盘（firstRunDialogs.ts 头注）；弹窗标题与按钮文案都随语言。 */
async function dismissOnboarding(page: Page, dialogTitle: string, skipLabel: string): Promise<void> {
  const onboarding = page.getByRole('dialog', { name: dialogTitle });
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

interface DeleteScenario {
  key: 'exact-5' | 'mixed-wildcard' | 'single-file';
  command: string;
  affectedPath: string;
  affectedFileCount?: number;
  consequence: string;
  /** 后果行里不许出现的名字（混通配符：第一个目标不许被点名）。 */
  mustNotName?: string;
}

const COPY = {
  zh: {
    onboardingTitle: '初始化 Neo',
    skipButton: '跳过，稍后在设置里配置',
    progress: '正在清理文件夹里的旧日志。',
    scenarios: [
      {
        key: 'exact-5',
        command: 'rm -rf 旧日志-1.log 旧日志-2.log 旧日志-3.log 旧日志-4.log 旧日志-5.log',
        affectedPath: '/workspace/logs/旧日志-1.log',
        affectedFileCount: 5,
        consequence: '将永久删除 旧日志-1.log、旧日志-2.log、旧日志-3.log 等 5 个（约 5 个文件），不进回收站。',
      },
      {
        key: 'mixed-wildcard',
        command: 'rm -rf 旧日志-1.log *.log',
        affectedPath: '/workspace/logs/旧日志-1.log',
        consequence: '将永久删除多个文件，不进回收站。',
        mustNotName: '旧日志-1.log',
      },
      {
        key: 'single-file',
        command: 'rm -rf 旧日志-1.log',
        affectedPath: '/workspace/logs/旧日志-1.log',
        affectedFileCount: 1,
        consequence: '将永久删除 /workspace/logs/旧日志-1.log（约 1 个文件），不进回收站。',
      },
    ] satisfies DeleteScenario[],
  },
  en: {
    onboardingTitle: 'Set up Neo',
    skipButton: 'Skip for now, set up later in Settings',
    progress: 'Cleaning up the old logs in the folder.',
    scenarios: [
      {
        key: 'exact-5',
        command: 'rm -rf old-log-1.log old-log-2.log old-log-3.log old-log-4.log old-log-5.log',
        affectedPath: '/workspace/logs/old-log-1.log',
        affectedFileCount: 5,
        consequence: 'Permanently deletes old-log-1.log, old-log-2.log, old-log-3.log and 2 more (5 files) without using Trash.',
      },
      {
        key: 'mixed-wildcard',
        command: 'rm -rf old-log-1.log *.log',
        affectedPath: '/workspace/logs/old-log-1.log',
        consequence: 'Permanently deletes multiple files without using Trash.',
        mustNotName: 'old-log-1.log',
      },
      {
        key: 'single-file',
        command: 'rm -rf old-log-1.log',
        affectedPath: '/workspace/logs/old-log-1.log',
        affectedFileCount: 1,
        consequence: 'Permanently deletes /workspace/logs/old-log-1.log (1 file) without using Trash.',
      },
    ] satisfies DeleteScenario[],
  },
} as const;

for (const language of ['zh', 'en'] as const) {
  const copy = COPY[language];
  for (const scenario of copy.scenarios as readonly DeleteScenario[]) {
    test(`删除审批卡后果行点名 · ${language} · ${scenario.key}`, async ({ page, request }, testInfo) => {
      const token = await acquireToken(request);
      await switchUiLanguage(request, token, language);
      await clearSessions(request, token);
      await page.goto('/');
      await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
      await dismissOnboarding(page, copy.onboardingTitle, copy.skipButton);
      const backToApp = page.getByRole('button', { name: '返回应用' });
      await backToApp.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
      if (await backToApp.isVisible().catch(() => false)) {
        await backToApp.click();
        await expect(backToApp).toBeHidden({ timeout: 10_000 });
      }

      const sessionId = await createCleanSession(page);
      const turnId = `delete-names-${language}-${scenario.key}-${Date.now()}`;

      await emitAgentEvents(request, token, [
        { type: 'turn_start', sessionId, data: { turnId } },
        { type: 'stream_chunk', sessionId, data: { turnId, content: copy.progress } },
        {
          // envelope sessionId 用 'global'（全局待审哨兵），data.sessionId 保留真实会话供应答路由。
          type: 'permission_request',
          sessionId: 'global',
          data: {
            id: `delete-names-req-${language}-${scenario.key}-${Date.now()}`,
            sessionId,
            forceConfirm: true,
            type: 'dangerous_command',
            tool: 'Bash',
            dangerLevel: 'danger',
            details: {
              command: scenario.command,
              commandRiskLevel: 'high',
              commandSecurityFlags: ['recursive_delete_targeted'],
              affectedPath: scenario.affectedPath,
              ...(scenario.affectedFileCount !== undefined ? { affectedFileCount: scenario.affectedFileCount } : {}),
            },
            boundary: { id: 'command.shell' },
            timestamp: Date.now(),
          },
        },
      ]);

      const permissionCard = page.getByTestId('permission-card');
      await expect(permissionCard).toBeVisible({ timeout: 15_000 });
      const consequence = permissionCard.getByTestId('permission-consequence');
      await expect(consequence).toBeVisible({ timeout: 15_000 });
      await expect(consequence).toHaveText(scenario.consequence);
      if (scenario.mustNotName) await expect(consequence).not.toContainText(scenario.mustNotName);
      // 证据行：截图前页面里实际读到的后果行文本。
      console.log(`[delete-consequence-names] ${language} ${scenario.key} permission-consequence = ${JSON.stringify(await consequence.textContent())}`);

      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
      });
      await page.screenshot({
        path: testInfo.outputPath(`delete-consequence-${language}-${scenario.key}.png`),
        animations: 'disabled',
        fullPage: true,
      });
    });
  }
}
