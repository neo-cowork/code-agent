// ============================================================================
// 「新邮件」触发创建入口 —— 真 app 截图验收（N-TRIGGER-MAIL-CREATE-ENTRY-K1 ⑤）
//
// 夹具：tests/e2e/fakeMailWebServer.ts（源码同款 esbuild 选项打包，经
// getConnectorRegistry().register() 注入假 mail 连接器，不触碰真实 Mail.app）。
// 形态由 NEO_FAKE_MAIL_STATE 驱动（每次 playwright 进程跑一种）：
//   ready / not-authorized / denied-after-ready / unsupported / not-enabled
// ready 跑编辑器 + /schedule 确认卡两组截图；四种不可用态各出一张状态截图。
// /schedule 的 generateFromPrompt 在 HTTP 层固定回放一份 mail 草案（被验的是
// 确认卡与卡内选择，不是模型；真模型真跑见证据档 ⑦）。
// ============================================================================

import { expect, test, type Page } from './fixtures/axeTest';
import fs from 'node:fs';
import path from 'node:path';
import { cronCenterEn, cronCenterZh } from '../../src/renderer/i18n/cronCenter';
import { cronEditorChromeEn, cronEditorChromeZh } from '../../src/renderer/i18n/cronEditorChrome';

test.setTimeout(120_000);
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const SHOT_DIR = path.join(process.cwd(), 'test-results');
const STATE = process.env.NEO_FAKE_MAIL_STATE ?? 'ready';

type Lang = 'zh' | 'en';
const COPY = {
  zh: { cc: cronCenterZh.cronCenter, chrome: cronEditorChromeZh.editorChrome, newTask: '新任务' },
  en: { cc: cronCenterEn.cronCenter, chrome: cronEditorChromeEn.editorChrome, newTask: 'New task' },
};

/** 界面语言走设置读取口（同 cronCloudUnconfiguredScheduleShots）：只改 ui.language，其余原样。 */
async function useLanguage(page: Page, language: Lang): Promise<void> {
  await page.route('**/api/domain/settings/get', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data = { ...body.data, ui: { ...body.data?.ui, language } };
    await route.fulfill({ response, json: body });
  });
}

/** generateFromPrompt 的固定回放草案（不编造账号：卡内选）。 */
const MAIL_DRAFT_FROM_MODEL = {
  name: '新邮件变待办',
  description: '有新邮件就整理成待办',
  enabled: true,
  scheduleType: 'event',
  schedule: { type: 'event', source: 'connector', connector: 'mail', eventName: 'message' },
  action: { type: 'agent', agentType: 'default', prompt: '把新邮件整理成待办清单' },
  restatement: { what: '盯着收件箱的新邮件', notifyWhen: '有新邮件到达时' },
};

async function waitForAppReady(page: Page): Promise<void> {
  const ssePromise = page.waitForResponse((resp) => resp.url().includes('/api/events'), { timeout: 20_000 });
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;
  for (const name of [/信任并加载|Trust and load/, /跳过，稍后|Skip for now/, /返回应用|Return to app/]) {
    const btn = page.getByRole('button', { name });
    await btn.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (await btn.first().isVisible().catch(() => false)) {
      await btn.first().click();
      await expect(btn.first()).toBeHidden({ timeout: 10_000 });
    }
  }
  await expect(page.getByTestId('sidebar-capability-zone')).toBeVisible({ timeout: 15_000 });
}

/** 打开自动化中心 → 新建 → 手动配置 → 调度类型选「新邮件」，停在 mail 字段组。 */
async function openEditorOnMailSchedule(page: Page, lang: Lang = 'zh'): Promise<void> {
  const copy = COPY[lang];
  await page.getByTestId('sidebar-capability-automation').click();
  await expect(page.getByTestId('cron-center-panel')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('cron-center-panel').getByText(copy.cc.create, { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByText(copy.cc.manualConfig, { exact: true }).click();
  // 调度类型 select：FormField 的 label 文本 → 同级包裹 div 里的 select（同
  // cronBudgetEditorFields 的 budgetField 取法）。
  const scheduleTypeField = dialog.getByText(copy.chrome.scheduleTypeLabel, { exact: true }).locator('xpath=..');
  await expect(scheduleTypeField.locator('select')).toBeVisible({ timeout: 10_000 });
  await scheduleTypeField.locator('select').selectOption('event-mail');
  await expect(dialog.locator('#cron-event-mail-account')).toBeVisible({ timeout: 10_000 });
}

test('编辑器：新邮件类型 + 账号/邮箱下拉（ready 态）', async ({ page }) => {
  test.skip(STATE !== 'ready', '仅 ready 态跑');
  await waitForAppReady(page);
  await openEditorOnMailSchedule(page);

  const accountSelect = page.locator('#cron-event-mail-account');
  await expect(accountSelect).toBeEnabled({ timeout: 10_000 });
  const accountLabels = await accountSelect.locator('option').allTextContents();
  expect(accountLabels.some((label) => label.includes('iCloud'))).toBe(true);
  expect(accountLabels.some((label) => label.includes('Gmail'))).toBe(true);

  // 选账号 → 邮箱下拉出该账号的目录；「只有保存后到达的新邮件触发」提示可见。
  await accountSelect.selectOption({ label: 'iCloud · 艾达' });
  const mailboxSelect = page.locator('#cron-event-mailbox');
  await expect(mailboxSelect).toBeEnabled();
  const mailboxLabels = await mailboxSelect.locator('option').allTextContents();
  expect(mailboxLabels).toEqual(['收件箱（默认）', '归档', '已发送']);
  await expect(page.getByTestId('cron-event-mail-seed-hint')).toBeVisible();

  // 预算填上（选完账号会亮 requires-budget 内联提示，与通道分支同一道闸门；
  // 截图取合规态，红框形态由 jsdom 测试钉）。
  const budget = page.getByRole('dialog').locator('#cron-event-mail-budget');
  await budget.fill('0.5');
  await expect(page.getByTestId('cron-event-mail-validation')).toHaveCount(0);

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // modal 体是 overflow-y-auto：mail 字段组在折叠线以下，先滚进视口再截
  //（用原生 scrollIntoView：scrollIntoViewIfNeeded 的可作用性等待在 modal 里会挂）。
  await page.getByTestId('cron-event-mail-seed-hint').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: path.join(SHOT_DIR, 'mail-entry-editor-ready.png') });
});

test('/schedule：mail 草案确认卡（行值 + 卡内选择 + 确认门）', async ({ page }) => {
  test.skip(STATE !== 'ready', '仅 ready 态跑');
  await waitForAppReady(page);

  // 模型调用在 HTTP 层固定回放（被验的是确认卡，不是模型）。
  await page.route('**/api/domain/cron/generateFromPrompt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MAIL_DRAFT_FROM_MODEL }),
    });
  });

  const newSessionBtn = page.getByRole('button', { name: '新任务' });
  await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });
  await newSessionBtn.click();
  const chatInput = page.locator('[data-chat-input]');
  await expect(chatInput).toBeVisible({ timeout: 10_000 });
  await chatInput.fill('/schedule 有新邮件就整理成待办');
  await chatInput.press('Enter');

  const card = page.locator('[data-schedule-confirm]');
  await expect(card).toBeVisible({ timeout: 15_000 });
  // 人话行：账号未选时的兜底文案；确认按钮被共享校验器禁用。
  const mailRow = page.locator('[data-schedule-row="mail"]');
  await expect(mailRow).toContainText('还没选');
  const confirmBtn = page.locator('[data-schedule-confirm-submit]');
  await expect(confirmBtn).toBeDisabled();

  // 卡内选账号：行值陈述实际绑定（新邮件 · 账号 · 收件箱），确认启用。
  const accountSelect = card.locator('#cron-event-mail-account');
  await expect(accountSelect).toBeEnabled({ timeout: 10_000 });
  await accountSelect.selectOption({ label: 'iCloud · 艾达' });
  await expect(confirmBtn).toBeEnabled({ timeout: 10_000 });
  await expect(mailRow).toContainText('新邮件 · iCloud · 艾达 · 收件箱');

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // 确认卡在聊天流里：滚到卡可见位置再截。
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: path.join(SHOT_DIR, 'mail-entry-confirm-card.png') });
});

// ---- N-FIX-UI-ENGLISH-RESIDUE-MAILBOX-TODO-REPLAY ⑦：监听邮箱的显示名（zh 译系统邮箱 / en 原样）----
const ACCOUNT_163 = '163 · 艾达';
const ACCOUNT_GMAIL = 'Gmail · ada.example@gmail.com';
const EXPECTED_MAILBOX_OPTIONS: Record<Lang, Record<string, string[]>> = {
  zh: {
    // 163：Junk 的译名和 163 自带的「垃圾邮件」重名，译出的那项带原名；其余系统邮箱只有中文名。
    [ACCOUNT_163]: ['收件箱（默认）', '广告邮件', '病毒文件夹', '草稿箱', '已发送', '已删除', '垃圾邮件（Junk）', '垃圾邮件', 'Receipts'],
    [ACCOUNT_GMAIL]: ['收件箱（默认）', '工作', '已发送', '草稿箱', '垃圾邮件', '已删除', '归档'],
  },
  en: {
    [ACCOUNT_163]: ['INBOX (inbox, default)', '广告邮件', '病毒文件夹', '草稿箱', 'Sent Messages', 'Deleted Messages', 'Junk', '垃圾邮件', 'Receipts'],
    [ACCOUNT_GMAIL]: ['INBOX (inbox, default)', '工作', '[Gmail]/Sent Mail', '[Gmail]/Drafts', '[Gmail]/Spam', '[Gmail]/Trash', '[Gmail]/All Mail'],
  },
};
const RAW_MAILBOX_VALUES: Record<string, string[]> = {
  [ACCOUNT_163]: ['', '广告邮件', '病毒文件夹', '草稿箱', 'Sent Messages', 'Deleted Messages', 'Junk', '垃圾邮件', 'Receipts'],
  [ACCOUNT_GMAIL]: ['', '工作', '[Gmail]/Sent Mail', '[Gmail]/Drafts', '[Gmail]/Spam', '[Gmail]/Trash', '[Gmail]/All Mail'],
};

/** 选账号 → 断言下拉每一项的显示名与 value → 选一个系统邮箱 → 打印断言行 → 截图。 */
async function shootMailboxDropdown(
  page: Page, lang: Lang, account: string, pick: string, shot: string, scope = page.locator('body'),
): Promise<void> {
  const accountSelect = scope.locator('#cron-event-mail-account');
  await expect(accountSelect).toBeEnabled({ timeout: 10_000 });
  await accountSelect.selectOption({ label: account });
  const mailboxSelect = scope.locator('#cron-event-mailbox');
  await expect(mailboxSelect).toBeEnabled();
  const options = mailboxSelect.locator('option');
  await expect(options).toHaveText(EXPECTED_MAILBOX_OPTIONS[lang][account]);
  const values = await options.evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
  expect(values).toEqual(RAW_MAILBOX_VALUES[account]);
  await mailboxSelect.selectOption(pick);
  await expect(mailboxSelect).toHaveValue(pick);
  const shown = await mailboxSelect.locator('option:checked').textContent();
  console.log(`ASSERT ${shot}: options=${JSON.stringify(await options.allTextContents())} values=${JSON.stringify(values)} selected=${JSON.stringify(shown)}`);
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await mailboxSelect.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: path.join(SHOT_DIR, `${shot}.png`) });
}

for (const lang of ['zh', 'en'] as const) {
  test(`编辑器：监听邮箱下拉的显示名 · ${lang}`, async ({ page }) => {
    test.skip(STATE !== 'ready', '仅 ready 态跑');
    await useLanguage(page, lang);
    await waitForAppReady(page);
    await openEditorOnMailSchedule(page, lang);
    const dialog = page.getByRole('dialog');
    await dialog.locator('#cron-event-mail-budget').fill('0.5');
    await shootMailboxDropdown(page, lang, ACCOUNT_163, 'Sent Messages', `mailbox-dropdown-${lang}-163`, dialog);
    await shootMailboxDropdown(page, lang, ACCOUNT_163, 'Junk', `mailbox-dropdown-${lang}-163-junk`, dialog);
    await shootMailboxDropdown(page, lang, ACCOUNT_GMAIL, '[Gmail]/Spam', `mailbox-dropdown-${lang}-gmail`, dialog);
  });

  test(`/schedule 卡与自动化列表：邮箱显示名 · ${lang}`, async ({ page }) => {
    test.skip(STATE !== 'ready', '仅 ready 态跑');
    const copy = COPY[lang];
    await useLanguage(page, lang);
    await waitForAppReady(page);
    const draft = lang === 'zh'
      ? { ...MAIL_DRAFT_FROM_MODEL, name: '已发送邮件归档提醒' }
      : {
        ...MAIL_DRAFT_FROM_MODEL,
        name: 'File sent mail',
        description: 'Turn each new email into a to-do',
        action: { ...MAIL_DRAFT_FROM_MODEL.action, prompt: 'Turn each new email into a to-do list' },
        restatement: { what: 'Watch the mailbox for new mail', notifyWhen: 'When new mail arrives' },
      };
    await page.route('**/api/domain/cron/generateFromPrompt', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: draft }) });
    });

    await page.getByRole('button', { name: copy.newTask, exact: true }).click();
    const chatInput = page.locator('[data-chat-input]');
    await expect(chatInput).toBeVisible({ timeout: 10_000 });
    await chatInput.fill(lang === 'zh' ? '/schedule 有新邮件就整理成待办' : '/schedule Turn each new email into a to-do');
    await chatInput.press('Enter');

    const card = page.locator('[data-schedule-confirm]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    const mailRow = page.locator('[data-schedule-row="mail"]');
    await shootMailboxDropdown(page, lang, ACCOUNT_163, 'Sent Messages', `mailbox-schedule-card-${lang}`, card);
    const expectedRow = lang === 'zh' ? '新邮件 · 163 · 艾达 · 已发送' : 'on new mail · 163 · 艾达 · Sent Messages';
    await expect(mailRow).toContainText(expectedRow);
    console.log(`ASSERT mailbox-schedule-card-${lang}: row=${JSON.stringify(await mailRow.innerText())}`);
    // 「正在解析…」提示条会盖住卡片：等它自己收起再截。
    await expect(page.locator('[role="alert"]')).toHaveCount(0, { timeout: 20_000 });
    await mailRow.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(SHOT_DIR, `mailbox-schedule-card-${lang}.png`) });

    // 确认创建 → 自动化列表的摘要行同一口径（保存的是原名 Sent Messages，显示按界面语言）。
    await card.locator('#cron-event-mail-budget').fill('0.5');
    const createRequest = page.waitForRequest('**/api/domain/cron/createJob');
    await page.locator('[data-schedule-confirm-submit]').click();
    const created = (await createRequest).postDataJSON().payload as { schedule: { mailbox?: string } };
    expect(created.schedule.mailbox).toBe('Sent Messages');
    await page.getByTestId('sidebar-capability-automation').click();
    const panel = page.getByTestId('cron-center-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const expectedSummary = lang === 'zh' ? '邮件消息 · 163 · 艾达 · 已发送' : 'Mail message · 163 · 艾达 · Sent Messages';
    // 数据目录跨次复用：按名字搜出本次建的任务再点开，列表和详情都只剩它。
    await panel.getByPlaceholder(copy.cc.searchPlaceholder).fill(draft.name);
    await panel.getByText(draft.name, { exact: true }).first().click();
    await expect(panel.getByText(expectedSummary).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[role="alert"]')).toHaveCount(0, { timeout: 20_000 });
    await panel.getByText(expectedSummary).first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
    console.log(`ASSERT mailbox-job-summary-${lang}: saved mailbox=${JSON.stringify(created.schedule.mailbox)} summary=${JSON.stringify(await panel.getByText(expectedSummary).first().innerText())}`);
    await page.screenshot({ path: path.join(SHOT_DIR, `mailbox-job-summary-${lang}.png`) });
  });
}

test('编辑器：连接器不可用三态的可区分提示', async ({ page }) => {
  // denied-after-ready（FB-541：缓存 ready 后 -1743）走 not-authorized 同款验收：
  // 专用「未授权」提示 + 去设置按钮，而不是只有重试的通用 read-error 提示。
  test.skip(!['not-authorized', 'denied-after-ready', 'unsupported', 'not-enabled'].includes(STATE), '仅不可用态跑');
  await waitForAppReady(page);
  await openEditorOnMailSchedule(page);

  const expected = {
    'not-authorized': '还没有通过授权',
    'denied-after-ready': '还没有通过授权',
    unsupported: '只在 macOS',
    'not-enabled': '还没有启用邮件连接器',
  }[STATE] ?? '';
  await expect(page.getByTestId('cron-event-mail-unavailable')).toContainText(expected, { timeout: 10_000 });

  if (STATE === 'not-authorized' || STATE === 'denied-after-ready' || STATE === 'not-enabled') {
    await expect(page.getByRole('dialog').getByRole('button', { name: '去设置' })).toBeVisible();
  } else {
    // 平台不支持：无可修复动作，不出去设置按钮。
    await expect(page.getByRole('dialog').getByRole('button', { name: '去设置' })).toHaveCount(0);
  }

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // 不可用提示在 modal 滚动区内：滚进视口再截（否则截到的只有上半段任务信息）。
  await page.getByTestId('cron-event-mail-unavailable').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: path.join(SHOT_DIR, `mail-entry-editor-${STATE}.png`) });
});
