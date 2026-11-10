import { expect, test, type Page } from './fixtures/axeTest';
import fs from 'node:fs';
import path from 'node:path';
import type { CreateCronJobDefinition } from '../../src/shared/contract/cron';
import { CRON_CLOUD_NOT_CONFIGURED } from '../../src/shared/constants/cronErrors';
import { cronCenterZh, cronCenterEn } from '../../src/renderer/i18n/cronCenter';

test.setTimeout(120_000);
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const SHOT_DIR = path.join(process.cwd(), 'test-results');

function fixedDraft(language: 'zh' | 'en') {
  return {
    name: language === 'zh' ? 'GitHub 通知摘要' : 'GitHub notification summary',
    enabled: true, runsOn: 'cloud', scheduleType: 'cron',
    schedule: { type: 'cron', expression: '0 9 * * 1-5' },
    action: { type: 'agent', agentType: 'default', prompt: language === 'zh'
      ? '汇总未读 GitHub 通知并发给我。' : 'Summarize my unread GitHub notifications and message me.' },
  };
}

async function scenario(page: Page, language: 'zh' | 'en', initiallyConfigured = false) {
  let configured = initiallyConfigured;
  const created: CreateCronJobDefinition[] = [];
  const attempts: CreateCronJobDefinition[] = [];
  await page.route('**/api/domain/settings/get', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data = { ...body.data, ui: { ...body.data?.ui, language },
      cronCloud: configured ? { baseUrl: 'https://cron.example.test' } : undefined };
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/domain/settings/getAllServiceKeys', route => route.fulfill({
    json: { success: true, data: configured ? { 'neo-cron-cloud': 'masked-fixture' } : {} },
  }));
  await page.route('**/api/domain/cron/generateFromPrompt', route => route.fulfill({
    json: { success: true, data: fixedDraft(language) },
  }));
  // Capture the actual renderer payload; creation is replayed because no cloud service is used.
  await page.route('**/api/domain/cron/createJob', async route => {
    const input = route.request().postDataJSON().payload as CreateCronJobDefinition;
    attempts.push(input);
    if (input.runsOn === 'cloud' && input.enabled && !configured) {
      console.log(`BLOCKED ${language} ${JSON.stringify(input)}`);
      await route.fulfill({ json: { success: false, error: { code: CRON_CLOUD_NOT_CONFIGURED, message: 'Cloud scheduler is not configured' } } });
      return;
    }
    created.push(input);
    console.log(`CREATE ${language} ${JSON.stringify(input)}`);
    await route.fulfill({ json: { success: true, data: { ...input, id: `fixture-${created.length}`, createdAt: 1, updatedAt: 1 } } });
  });
  await page.goto('/');
  await expect(page.getByTestId('sidebar-capability-zone')).toBeVisible({ timeout: 20_000 });
  for (const name of [/信任并加载|Trust and load/, /跳过，稍后|Skip for now/, /返回应用|Return to app/]) {
    const button = page.getByRole('button', { name }).first();
    await button.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (await button.isVisible()) await button.click();
  }
  return { created, attempts, configureCloud: () => { configured = true; } };
}

async function openSchedule(page: Page, language: 'zh' | 'en') {
  await page.getByRole('button', { name: language === 'zh' ? '新任务' : 'New task', exact: true }).click();
  const input = page.locator('[data-chat-input]');
  await input.fill(language === 'zh' ? '/schedule 每个工作日9点汇总未读 GitHub 通知并发给我'
    : '/schedule Every weekday at 9am summarize my unread GitHub notifications and message me');
  await input.press('Enter');
  const card = page.locator('[data-schedule-confirm]');
  await expect(card).toBeVisible();
  await expect(card.locator('select')).toHaveValue('cloud');
  return card;
}

async function noticeShot(page: Page, name: string, language: 'zh' | 'en') {
  const copy = (language === 'zh' ? cronCenterZh : cronCenterEn).cronCenter.cloudCreate;
  const notice = page.getByTestId('cron-cloud-create-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(copy.unconfigured);
  await expect(notice.getByRole('button', { name: copy.switchLocal, exact: true })).toBeVisible();
  await expect(notice.getByRole('button', { name: copy.settings, exact: true })).toBeVisible();
  if (language === 'en') expect(await notice.innerText()).not.toMatch(/[\u3400-\u9fff]/u);
  await notice.scrollIntoViewIfNeeded();
  console.log(`ASSERT ${name}: ${JSON.stringify(await notice.innerText())}`);
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') });
}

test('zh /schedule unconfigured: local recovery keeps the draft and creates a local job', async ({ page }) => {
  const fixture = await scenario(page, 'zh');
  const card = await openSchedule(page, 'zh');
  await card.locator('[data-schedule-confirm-submit]').click();
  await noticeShot(page, 'cron-cloud-unconfigured-chat-zh', 'zh');
  expect(fixture.attempts).toHaveLength(1);
  expect(fixture.attempts[0]).toMatchObject({ enabled: true, runsOn: 'cloud' });
  expect(fixture.created).toHaveLength(0);
  await card.getByRole('button', { name: cronCenterZh.cronCenter.cloudCreate.switchLocal, exact: true }).click();
  await expect(card.locator('select')).toHaveValue('local');
  await expect(page.getByTestId('cron-cloud-create-notice')).toHaveCount(0);
  await card.locator('[data-schedule-confirm-submit]').click();
  await expect.poll(() => fixture.created.length).toBe(1);
  expect(fixture.created[0]).toMatchObject({ ...fixedDraft('zh'), runsOn: 'local' });
  await expect(card).toHaveCount(0);
});

test('en /schedule unconfigured: English notice has both actions and no Chinese copy', async ({ page }) => {
  await scenario(page, 'en');
  const card = await openSchedule(page, 'en');
  await card.locator('[data-schedule-confirm-submit]').click();
  await noticeShot(page, 'cron-cloud-unconfigured-chat-en', 'en');
});

test('zh /schedule configured: no notice and confirmation still creates a cloud job', async ({ page }) => {
  const fixture = await scenario(page, 'zh', true);
  const card = await openSchedule(page, 'zh');
  await expect(card.locator('[data-schedule-confirm-submit]')).toBeEnabled();
  await expect(page.getByTestId('cron-cloud-create-notice')).toHaveCount(0);
  console.log('ASSERT cron-cloud-configured-chat-zh: card visible, confirm enabled, no setup notice');
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, 'cron-cloud-configured-chat-zh.png') });
  await card.locator('[data-schedule-confirm-submit]').click();
  await expect.poll(() => fixture.created.length).toBe(1);
  expect(fixture.created[0]).toMatchObject(fixedDraft('zh'));
  await expect(card).toHaveCount(0);
});

test('zh /schedule settings round trip returns to the same chat draft', async ({ page }) => {
  const fixture = await scenario(page, 'zh');
  const card = await openSchedule(page, 'zh');
  await card.locator('[data-schedule-confirm-submit]').click();
  await card.getByRole('button', { name: cronCenterZh.cronCenter.cloudCreate.settings, exact: true }).click();
  await expect(card).toHaveCount(0);
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await expect(settings).toBeVisible();
  fixture.configureCloud();
  await settings.getByRole('button', { name: '关闭', exact: true, disabled: false }).click();
  await expect(card).toBeVisible();
  await expect(page.getByTestId('cron-center-panel')).toHaveCount(0);
  await expect(card.locator('[data-schedule-row="what"]')).toContainText(fixedDraft('zh').name);
  await expect(card.locator('select')).toHaveValue('cloud');
  await expect(page.getByTestId('cron-cloud-create-notice')).toHaveCount(0);
  await card.locator('[data-schedule-confirm-submit]').click();
  await expect.poll(() => fixture.created.length).toBe(1);
  expect(fixture.created[0]).toMatchObject(fixedDraft('zh'));
});

test('en editor unconfigured: localized notice and both recovery options', async ({ page }) => {
  await scenario(page, 'en');
  await page.getByTestId('sidebar-capability-automation').click();
  await page.getByTestId('cron-center-panel').getByText('New', { exact: true }).click();
  const form = page.getByTestId('cron-simple-create');
  await form.locator('textarea').fill(fixedDraft('en').action.prompt);
  await form.getByTestId('cron-runs-on-cloud').click();
  await form.getByRole('button', { name: 'Create automation', exact: true }).click();
  await expect(page.getByTestId('cron-pending-routine-restate')).toBeVisible();
  await page.getByTestId('cron-pending-routine-confirm').click();
  await noticeShot(page, 'cron-cloud-unconfigured-editor-en', 'en');
});

test('en template unconfigured: localized notice and both recovery options', async ({ page }) => {
  await scenario(page, 'en');
  await page.getByTestId('sidebar-capability-automation').click();
  await page.getByTestId('cron-center-panel').getByText('New', { exact: true }).click();
  await page.getByRole('dialog').getByText('From a template', { exact: true }).click();
  // This existing template has no localized picker name; only the new notice is under test.
  await page.getByRole('dialog').getByRole('button').filter({ hasText: '网页更新提醒' }).click();
  await page.getByPlaceholder('粘贴要关注的网页地址', { exact: true }).fill('https://github.com/notifications');
  await page.getByRole('dialog').getByTestId('cron-runs-on-cloud').click();
  await page.getByRole('dialog').getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByTestId('cron-pending-routine-restate')).toBeVisible();
  await page.getByTestId('cron-pending-routine-confirm').click();
  await noticeShot(page, 'cron-cloud-unconfigured-template-en', 'en');
});
