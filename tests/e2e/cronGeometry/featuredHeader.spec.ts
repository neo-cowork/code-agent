import { expect, test } from '@playwright/test';
import { dismissFirstRunDialogs } from '../firstRunDialogs';

test.describe.configure({ mode: 'serial' });

for (const language of ['zh', 'en'] as const) {
  test(`recommended block stays above the fully visible detail header (${language})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await dismissFirstRunDialogs(page);
    await page.getByTestId('sidebar-capability-automation').waitFor();
    await page.evaluate(async (nextLanguage) => {
      const response = await window.domainAPI?.invoke('settings', 'set', { ui: { language: nextLanguage } });
      if (!response?.success) throw new Error('Could not set UI language');
    }, language);
    await page.goto('/?open=automation');
    const skip = page.getByRole('button', { name: /^(跳过，稍后在设置里配置|Skip for now, set up later in Settings)$/ });
    await skip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    if (await skip.isVisible()) await skip.click();
    const name = language === 'zh' ? '记忆整理' : 'Memory cleanup';
    await page.getByRole('button', { name: new RegExp(name) }).first().click();
    const heading = page.getByRole('heading', { name, exact: true });
    await expect(heading).toBeVisible();
    const geometry = await heading.evaluate((element) => {
      const detail = element.closest('.contain-size');
      const featured = document.querySelector('[data-testid="cron-featured-templates"]');
      const header = element.parentElement?.parentElement?.parentElement;
      if (!detail || !featured || !header) throw new Error('Missing automation geometry targets');
      const rect = (node: Element) => {
        const r = node.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      return {
        featured: rect(featured), detailRoot: rect(detail), header: rect(header),
        title: rect(element), viewport: { width: innerWidth, height: innerHeight },
        buttons: Array.from(header.querySelectorAll('button'), (button) => ({ text: button.textContent, ...rect(button) })),
      };
    });
    console.log(`${language} geometry ${JSON.stringify(geometry)}`);
    expect(geometry.featured.bottom, 'featured.bottom <= detailRoot.top').toBeLessThanOrEqual(geometry.detailRoot.top);
    expect(geometry.buttons).toHaveLength(4);
    for (const box of [geometry.header, geometry.title, ...geometry.buttons]) {
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
      expect(box.top).toBeGreaterThanOrEqual(Math.max(0, geometry.detailRoot.top));
      expect(box.bottom).toBeLessThanOrEqual(Math.min(geometry.viewport.height, geometry.detailRoot.bottom));
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(geometry.viewport.width);
    }
    expect(geometry.buttons.map((button) => button.text)).toEqual(language === 'zh'
      ? ['编辑', '停用', '手动触发', '删除'] : ['Edit', 'Disable', 'Run now', 'Delete']);
  });
}
