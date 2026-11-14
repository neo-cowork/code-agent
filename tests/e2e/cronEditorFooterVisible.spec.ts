import { expect, test, type Locator, type Page } from './fixtures/axeTest';
import path from 'node:path';
import fs from 'node:fs';
import { dismissFirstRunDialogs } from './firstRunDialogs';
import { installGeometrySensor } from './fixtures/geometrySensor';

test.setTimeout(120_000);

const viewports = [{ width: 1500, height: 950 }, { width: 1280, height: 640 }];
const goal = '整理我关注的竞品动态，汇总产品更新、价格变化和待跟进事项，给出附带来源链接的每周简报。'.repeat(8);
type Layout = 'simple' | 'template' | 'manual';

async function waitForAppReady(page: Page): Promise<void> {
  const events = page.waitForResponse((response) => response.url().includes('/api/events'));
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible();
  await events;
  await dismissFirstRunDialogs(page);
  const back = page.getByRole('button', { name: '返回应用', exact: true });
  if (await back.isVisible()) await back.click();
  await expect(page.getByTestId('sidebar-capability-zone')).toBeVisible();
}

async function fillResultTarget(page: Page): Promise<void> {
  const field = page.getByTestId('cron-result-channel-field');
  const account = field.locator('#cron-result-channel-account');
  await expect(account).toBeEnabled();
  const values = await account.locator('option').evaluateAll((options) => options
    .filter((option) => !(option as HTMLOptionElement).disabled && (option as HTMLOptionElement).value)
    .map((option) => (option as HTMLOptionElement).value));
  if (values.length === 0) {
    await expect(field).toContainText('还没有连接消息通道');
    console.log('RESULT_TARGET no connected account in isolated data; optional fields + expanded comparison force overflow');
    return;
  }
  await account.selectOption(values[0]);
  const conversation = field.getByRole('combobox', { name: '选择接收会话' });
  const manual = field.locator('#cron-result-channel-manual');
  await expect(conversation.or(manual)).toBeVisible();
  if (await conversation.isVisible()) {
    const destination = await conversation.locator('option:not([disabled])').first().getAttribute('value');
    expect(destination).toBeTruthy();
    await conversation.selectOption(destination!);
  } else {
    await manual.fill('weekly-brief');
  }
  console.log('RESULT_TARGET channel and receiving chat selected');
}

async function openFilledEditor(page: Page, layout: Layout): Promise<Locator> {
  // Deliberately use the real sidebar and Add automation entry, never a mounted component.
  await page.getByTestId('sidebar-capability-automation').click();
  const panel = page.getByTestId('cron-center-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '新建', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  if (layout === 'template') {
    await dialog.getByRole('button', { name: '从模板创建', exact: true }).click();
    await dialog.getByRole('button', { name: /网页更新提醒/ }).click();
    await dialog.getByPlaceholder('粘贴要关注的网页地址').fill('https://example.com/product-updates');
    await dialog.getByPlaceholder('例如：每天 9:00、每 2 小时').fill('每天 9:00');
    await page.getByTestId('cron-budget-limit-input').fill('0.50');
  } else {
    await dialog.getByPlaceholder('例如：读一遍我关注的竞品动态，整理成简报').fill(goal);
    await dialog.getByPlaceholder('不填就用目标开头').fill('每周竞品动态简报');
    await page.getByTestId('cron-simple-urgency-criteria').fill('只有价格或核心功能发生变化才通知');
    await page.getByTestId('cron-budget-limit-input').fill('0.50');
    await fillResultTarget(page);
    if (layout === 'manual') {
      await dialog.getByRole('button', { name: '手动配置', exact: true }).click();
      await dialog.getByPlaceholder('简要说明任务用途').fill(goal);
      await dialog.getByPlaceholder('daily, backup').fill('竞品,周报,产品更新');
    } else {
      await dialog.locator('select').filter({ has: page.locator('option[value="weekly"]') }).selectOption('weekly');
      await page.getByTestId('cron-simple-time-hour').selectOption('09');
      await page.getByTestId('cron-simple-time-minute').selectOption('00');
      await expect(page.getByTestId('cron-stagger-hint')).toBeVisible();
    }
  }
  await page.getByTestId('cron-runs-on-selector').getByRole('button', { name: '有什么不同?' }).click();
  await expect(page.getByTestId('cron-location-comparison')).toBeVisible();
  return dialog.getByRole('button', { name: layout === 'simple' ? '创建自动化' : '创建任务', exact: true });
}

async function measure(button: Locator) {
  return button.evaluate((element) => {
    const dialog = element.closest('[role="dialog"]')!;
    const content = dialog.querySelector<HTMLElement>(':scope > .overflow-y-auto')!;
    const rect = element.getBoundingClientRect();
    const bounds = dialog.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const box = (value: DOMRect) => ({ x: value.x, y: value.y, width: value.width, height: value.height });
    return {
      dialog: box(bounds), button: box(rect), viewportHeight: window.innerHeight,
      fullyVisible: rect.width > 0 && rect.height > 0 && rect.left >= Math.max(0, bounds.left)
        && rect.right <= Math.min(window.innerWidth, bounds.right)
        && rect.top >= Math.max(0, bounds.top) && rect.bottom <= Math.min(window.innerHeight, bounds.bottom),
      hit: hit === element || element.contains(hit),
      scrollTop: content.scrollTop, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight,
    };
  });
}

for (const layout of ['simple', 'template', 'manual'] as const) {
  test(`Add automation footer: ${layout} visible and clickable at both window sizes`, async ({ page }, testInfo) => {
    await waitForAppReady(page);
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      const button = await openFilledEditor(page, layout);
      const dialog = page.getByRole('dialog');
      const content = dialog.locator(':scope > .overflow-y-auto');
      const sensor = await installGeometrySensor(page);
      // Top/middle/bottom measurements prevent Playwright's automatic scrollIntoView masking clipping.
      for (const fraction of [0, 0.5, 1]) {
        await content.evaluate((element, position) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * position; }, fraction);
        const geometry = await measure(button);
        console.log(`FOOTER ${JSON.stringify({ layout, viewport, fraction, ...geometry })}`);
        if (fraction === 0) {
          const directory = process.env.CRON_FOOTER_OUTPUT_DIR || testInfo.outputDir;
          fs.mkdirSync(directory, { recursive: true });
          const screenshot = path.join(directory, `${layout}-${viewport.width}x${viewport.height}.png`);
          await expect(button).toBeVisible();
          console.log(`SCREENSHOT_ASSERT ${layout} create button rendered; path=${screenshot}`);
          await page.screenshot({ path: screenshot });
        }
        expect.soft(geometry.fullyVisible, `${layout} ${viewport.width}x${viewport.height} scroll=${fraction}: fully visible`).toBe(true);
        expect.soft(geometry.hit, `${layout} ${viewport.width}x${viewport.height} scroll=${fraction}: centre hit`).toBe(true);
        if (viewport.height === 640) {
          expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
          if (fraction > 0) expect(geometry.scrollTop).toBeGreaterThan(0);
        }
      }
      await sensor.assertClean();
      // Headless maximize comparison: enlarge the same filled dialog, then restore the normal window.
      await page.setViewportSize({ width: 1920, height: 1080 });
      await content.evaluate((element) => { element.scrollTop = 0; });
      const maximized = await measure(button);
      console.log(`MAXIMIZED ${JSON.stringify({ layout, from: viewport, ...maximized })}`);
      expect(maximized.fullyVisible).toBe(true);
      expect(maximized.hit).toBe(true);
      await expect(button).toBeVisible();
      const directory = process.env.CRON_FOOTER_OUTPUT_DIR || testInfo.outputDir;
      console.log(`SCREENSHOT_ASSERT ${layout} maximized create button rendered; from=${viewport.width}x${viewport.height}`);
      await page.screenshot({ path: path.join(directory, `${layout}-${viewport.width}x${viewport.height}-maximized.png`) });
      await page.setViewportSize(viewport);
      await content.evaluate((element) => { element.scrollTop = 0; });
      const restored = await measure(button);
      expect(restored.fullyVisible).toBe(true);
      expect(restored.hit).toBe(true);
      const cancel = dialog.getByRole('button', { name: '取消', exact: true });
      if (layout !== 'simple') {
        const cancelGeometry = await measure(cancel);
        console.log(`CANCEL ${JSON.stringify({ layout, viewport, ...cancelGeometry })}`);
        expect(cancelGeometry.fullyVisible).toBe(true);
        expect(cancelGeometry.hit).toBe(true);
      }
      // A coordinate click cannot scroll a hidden action into view, unlike locator.click().
      await page.mouse.click(restored.button.x + restored.button.width / 2, restored.button.y + restored.button.height / 2);
      await expect(page.getByTestId('cron-pending-routine-restate')).toBeVisible();
      console.log(`CLICK_NEXT_STATE ${layout} ${viewport.width}x${viewport.height}: pending routine confirmation visible`);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
  });
}
