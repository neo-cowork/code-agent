import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from './fixtures/axeTest';
import type { AgentEvent } from '../../src/shared/contract';

type APIResponse = Awaited<ReturnType<APIRequestContext['post']>>;

// N-FIX-APPROVAL-BAR-COLLAPSED-HIDES-ACTION-REDO：多步任务（提醒 + 邮件草稿 + 日程）同时待确认时，
// 每张审批卡不展开详情就要说清「做什么、对什么」，并保留「还有 N 项」；逐张确认，不做批量批准。
//
// 三条审批不是手搓的事件：它们走 /api/dev/exec-tool + requireRealApproval，由宿主真实的
// ToolExecutor 权限管线构造并广播（toolExecutor.ts buildPermissionRequest → default 分支 →
// connectorTokenWrite.ts connectorWritePermissionRequest；dev.ts requestDevToolPermission 广播），
// 所以卡上的请求形状就是宿主发出的形状。点「允许 / 创建」走真实的应答投递（不是「已在其他设备处理」）；
// 投递后工具因本隔离环境未启用原生连接器而在连接前退出（NOT_INITIALIZED），不会碰邮件 / 日历 / 提醒事项。
// 整个用例不点「更多选项与详情」也不点「收起」：每张截图都是该卡的默认形态。

type RendererAgentEvent = AgentEvent & { sessionId?: string };

test.setTimeout(150_000);
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
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });
  // 首载可能先自动建一条会话、点「新任务」后又切到另一条：当前会话 id 连续两次读数一致才算落定。
  const activeSession = page.locator('[data-session-id][aria-current="true"]').first();
  let sessionId: string | null = null;
  await expect.poll(async () => {
    const current = await activeSession.getAttribute('data-session-id', { timeout: 2_000 }).catch(() => null);
    const settled = current !== null && current === sessionId;
    sessionId = current;
    return settled;
  }, { timeout: 15_000, intervals: [750] }).toBe(true);
  return sessionId!;
}

/** 宿主本地时区的「明天 HH:00」，与工具 schema 首选的 *_local 入参同形（宿主负责换算成毫秒）。 */
function tomorrowLocal(hour: number): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(hour)}:00`;
}

/**
 * 旁听 /api/events，把宿主广播的 permission_request 原样记下来（证据：卡上渲染的正是宿主发出的载荷）。
 * 只读订阅，不改页面。
 */
function recordHostPermissionBroadcasts(baseURL: string, token: string): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  let buffer = '';
  const req = http.get(new URL('/api/events', baseURL), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
  }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.includes('"permission_request"')) lines.push(frame);
        boundary = buffer.indexOf('\n\n');
      }
    });
  });
  req.on('error', () => {});
  return { lines, stop: () => req.destroy() };
}

interface HostToolCall {
  response: Promise<APIResponse>;
  settled: boolean;
}

/** 宿主真实权限管线：requireRealApproval 让请求挂起，直到真人在审批卡上裁决才返回。 */
function startHostToolCall(
  request: APIRequestContext,
  token: string,
  tool: string,
  params: Record<string, unknown>,
): HostToolCall {
  const response = request.post('/api/dev/exec-tool', {
    data: { tool, params, allowWrite: true, requireRealApproval: true, sessionId: 'global' },
    headers: { Authorization: `Bearer ${token}` },
    timeout: 120_000,
  });
  const call: HostToolCall = { response, settled: false };
  void response.then(() => { call.settled = true; }, () => { call.settled = true; });
  return call;
}

const COPY = {
  zh: {
    skipButton: '跳过，稍后在设置里配置',
    narration: '正在帮你建提醒、存邮件草稿、建日程。',
    reminder: { list: '提醒事项', title: '提交周报' },
    mail: { to: ['alice@example.com'], subject: '本周进度同步', content: '附件是本周进度' },
    calendar: { calendar: '工作', title: '产品评审' },
    // 展示顺序由 DecisionSlot.priorityOf 决定：可编辑写回卡（提醒、日程）排在邮件草稿前。
    cards: [
      { tool: 'reminders_create', question: '新建提醒「提交周报」？', remaining: '还有 2 项', approve: /^创建\s*y?$/u, viewMode: 'expanded' },
      { tool: 'calendar_create_event', question: '创建日历事件「产品评审」？', remaining: '还有 1 项', approve: /^创建\s*y?$/u, viewMode: 'expanded' },
      { tool: 'mail_draft', question: '保存邮件草稿「本周进度同步」？', remaining: null, approve: /^允许$/u, viewMode: 'compact' },
    ],
    anyRemaining: /还有 \d+ 项/u,
    contentFree: ['允许这次操作？', '允许进行以下操作？', '新建这个提醒？', '创建这个日历事件？'],
    detailsToggle: '更多选项与详情',
    standingGrants: ['本次任务内允许', '24 小时内允许'],
  },
  en: {
    skipButton: 'Skip for now, set up later in Settings',
    narration: 'Creating the reminder, saving the email draft and adding the event.',
    reminder: { list: 'Reminders', title: 'Submit weekly report' },
    mail: { to: ['alice@example.com'], subject: 'Weekly progress sync', content: 'Attached is this week’s progress' },
    calendar: { calendar: 'Work', title: 'Product review' },
    cards: [
      { tool: 'reminders_create', question: 'Create reminder “Submit weekly report”?', remaining: '2 more', approve: /^Create\s*y?$/u, viewMode: 'expanded' },
      { tool: 'calendar_create_event', question: 'Create calendar event “Product review”?', remaining: '1 more', approve: /^Create\s*y?$/u, viewMode: 'expanded' },
      { tool: 'mail_draft', question: 'Save an email draft “Weekly progress sync”?', remaining: null, approve: /^Allow$/u, viewMode: 'compact' },
    ],
    anyRemaining: /\b\d+ more\b/u,
    contentFree: ['Allow this operation?', 'Allow the following operation?', 'Create this reminder?', 'Create this calendar event?'],
    detailsToggle: 'More options & details',
    standingGrants: ['Allow for this task', 'Allow for 24 hours'],
  },
} as const;

const RAW_TOOL_NAMES = ['reminders_create', 'mail_draft', 'calendar_create_event'];

for (const language of ['zh', 'en'] as const) {
  const copy = COPY[language];

  test(`多步任务逐张审批：每张卡默认形态说清动作与对象 · ${language}`, async ({ page, request, baseURL }, testInfo) => {
    const outputFile = (name: string): string => {
      const dir = process.env.COMPACT_BAR_SHOT_DIR;
      if (!dir) return testInfo.outputPath(name);
      fs.mkdirSync(dir, { recursive: true });
      return path.join(dir, name);
    };
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
    const turnId = `compact-walkthrough-${language}-${Date.now()}`;
    await emitAgentEvents(request, token, [
      { type: 'turn_start', sessionId, data: { turnId } },
      { type: 'stream_chunk', sessionId, data: { turnId, content: copy.narration } },
    ]);
    // 卡片背后必须是这轮任务所在的会话，而不是另一条空会话。
    await expect(page.getByText(copy.narration)).toBeVisible({ timeout: 15_000 });

    const broadcasts = recordHostPermissionBroadcasts(baseURL!, token);
    const card = page.getByTestId('permission-card');

    // 一条一条发起，保证到达顺序确定（提醒 → 邮件草稿 → 日程），队列计数逐步涨到 2。
    const hostCalls = new Map<string, HostToolCall>();
    hostCalls.set('reminders_create', startHostToolCall(request, token, 'reminders_create', {
      list: copy.reminder.list,
      title: copy.reminder.title,
      remind_at_local: tomorrowLocal(10),
    }));
    await expect(card).toContainText(copy.cards[0].question, { timeout: 45_000 });
    hostCalls.set('mail_draft', startHostToolCall(request, token, 'mail_draft', {
      to: [...copy.mail.to],
      subject: copy.mail.subject,
      content: copy.mail.content,
    }));
    await expect(card).toContainText(copy.cards[1].remaining, { timeout: 30_000 });
    hostCalls.set('calendar_create_event', startHostToolCall(request, token, 'calendar_create_event', {
      calendar: copy.calendar.calendar,
      title: copy.calendar.title,
      start_local: tomorrowLocal(15),
      end_local: tomorrowLocal(16),
    }));
    await expect(card).toContainText(copy.cards[0].remaining, { timeout: 30_000 });
    const hostResults: Array<{ tool: string; status: number; success?: boolean; code?: string; error?: string }> = [];

    for (const [index, expected] of copy.cards.entries()) {
      // 新会话的 idle 快照迟到会撤回运行态（visual-shotbase.spec.ts 同款防御）：截图前补一发同 turn keepalive。
      await emitAgentEvents(request, token, [
        { type: 'stream_chunk', sessionId, data: { turnId, content: ' ' } },
      ]);
      await expect(card).toBeVisible({ timeout: 10_000 });
      await expect(card).toContainText(expected.question, { timeout: 15_000 });
      if (expected.remaining) {
        await expect(card).toContainText(expected.remaining);
      } else {
        await expect(card).not.toContainText(copy.anyRemaining);
      }
      for (const sentence of [...COPY.zh.contentFree, ...COPY.en.contentFree]) {
        await expect(card).not.toContainText(sentence);
      }
      for (const toolName of RAW_TOOL_NAMES) {
        await expect(card).not.toContainText(toolName);
      }
      // 默认形态：写回卡（带可编辑字段）默认展开，邮件草稿卡默认收起；本用例从不点展开 / 收起。
      await expect(card.locator('[data-view-mode]')).toHaveAttribute('data-view-mode', expected.viewMode);
      if (expected.viewMode === 'compact') {
        await expect(card.getByRole('button', { name: copy.detailsToggle, exact: true }))
          .toHaveAttribute('aria-expanded', 'false');
        for (const grant of copy.standingGrants) {
          await expect(card).not.toContainText(grant);
        }
      }
      const cardText = (await card.innerText()).replace(/\s+/gu, ' ').trim();
      console.log(`[compact-walkthrough:${language}] card ${index + 1}/${copy.cards.length} ${expected.tool} view=${expected.viewMode} text="${cardText}"`);

      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
      });
      await expect(card).toContainText(expected.question);
      await page.screenshot({
        path: outputFile(`compact-card${index + 1}-${expected.tool}-${language}.png`),
        animations: 'disabled',
        fullPage: false,
      });

      // 这张卡对应的宿主请求还挂着，点「允许 / 创建」才放行：点击投递给宿主（不是「已在其他设备处理」），
      // 工具随后进入执行体，在连接原生应用前因本环境未启用连接器而退出（NOT_INITIALIZED 只在放行后才可能出现）。
      const hostCall = hostCalls.get(expected.tool)!;
      expect(hostCall.settled, `${expected.tool} host request should still wait for this card`).toBe(false);
      await card.getByRole('button', { name: expected.approve }).click();
      const response = await hostCall.response;
      const body = (await response.json()) as { success?: boolean; error?: string; metadata?: { code?: string } };
      hostResults.push({ tool: expected.tool, status: response.status(), success: body.success, code: body.metadata?.code, error: body.error });
      expect(response.status(), `${expected.tool} exec-tool HTTP status`).toBe(200);
      expect(body.success, `${expected.tool} must not reach the native app`).toBe(false);
      expect(body.metadata?.code, `${expected.tool} approval delivered as allow`).toBe('NOT_INITIALIZED');
      await expect(card.getByText(expected.question, { exact: true })).toBeHidden({ timeout: 15_000 });
    }

    await expect(card).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(language === 'zh' ? '已在其他设备处理' : 'Already handled on another device')).toHaveCount(0);
    broadcasts.stop();
    console.log(`[compact-walkthrough:${language}] host results ${JSON.stringify(hostResults)}`);
    expect(broadcasts.lines.length, 'host permission_request broadcasts captured').toBeGreaterThanOrEqual(3);
    fs.writeFileSync(outputFile(`host-permission-requests-${language}.sse.txt`), `${broadcasts.lines.join('\n\n')}\n`);
    fs.writeFileSync(outputFile(`host-exec-results-${language}.json`), `${JSON.stringify(hostResults, null, 2)}\n`);
  });
}
