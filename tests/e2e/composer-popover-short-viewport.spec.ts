// ============================================================================
// E2E: FB-3234 / N-FIX-COMPOSER-POPOVER-CLIPPED-SHORT-VIEWPORT
// 矮窗(900x500) + composer 撑到最大高时，composer 上弹面板不再被顶出窗口：
// popover 顶边 >= 聊天区顶（TitleBar 下沿），首行 / @ 分类 tab 完整可见且
// elementFromPoint 命中、可点。1440x900 + 单行 composer 校验行为不变（cap 280/240）。
// ============================================================================

import { test, expect, type Locator, type Page } from './fixtures/axeTest';

test.setTimeout(120_000);

// 首启遮罩（信任文件夹 → 模型 onboarding → 跳过后落在设置页），出现才点。
async function dismissOverlays(page: Page): Promise<void> {
  for (const name of ['信任并加载', '跳过，稍后在设置里配置']) {
    const btn = page.getByRole('button', { name });
    await btn.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await expect(btn).toBeHidden({ timeout: 10_000 });
    }
  }
  const backToApp = page.getByRole('button', { name: '返回应用' });
  await backToApp.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await backToApp.isVisible().catch(() => false)) {
    await backToApp.click();
    await expect(backToApp).toBeHidden({ timeout: 10_000 });
  }
}

async function openComposer(page: Page): Promise<Locator> {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await dismissOverlays(page);
  const newTask = page.getByRole('button', { name: /^(新任务|New task)/ });
  await newTask.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  if (await newTask.isVisible().catch(() => false)) await newTask.click();
  const editor = page.getByTestId('chat-composer-textarea');
  await editor.waitFor({ state: 'visible', timeout: 10_000 });
  await editor.click();
  await expect(editor).toBeFocused();
  return editor;
}

async function growComposer(page: Page, editor: Locator, lines: number): Promise<void> {
  const text = Array.from({ length: lines }, (_, i) => `draft line ${i + 1} filler`).join('\n');
  // 必须走真实 paste 路径（InputArea.onPaste → insertPlainTextAtCaret 产 '\n' 文本节点）。
  // keyboard.insertText 会让 Chromium 产 <div> 块级节点——真实用户经粘贴/Shift+Enter
  // 到不了这种结构，且会让 caret 纯文本偏移少算块边界（该行内模型按 '\n' 记账）。
  await editor.evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
  // 非空转断言：composer 真的被 30 行撑大（否则后面「顶边受限」全是空转）
  const composer = page.locator('.composer-elevated');
  const box = await composer.boundingBox();
  expect(box, 'composer did not grow').toBeTruthy();
  expect(box!.height, `composer height ${box!.height} too small after ${lines} lines`).toBeGreaterThan(180);
}

function boundaryTop(page: Page): Promise<number> {
  return page.locator('[data-composer-popover-boundary]').evaluate(
    (el) => el.getBoundingClientRect().top,
  );
}

// popover-enter 入场动画会让 boundingBox 在几毫秒内变化：分两次量出的「容器 vs 子元素」
// 可能处于不同动画帧，导致「子元素跑出容器上沿」的假性越界。等 box 连续两次读数一致再断言。
async function settledBox(el: Locator, label: string) {
  let box = await el.boundingBox();
  for (let i = 0; i < 40; i += 1) {
    await el.page().waitForTimeout(50);
    const next = await el.boundingBox();
    if (box && next && box.x === next.x && box.y === next.y && box.width === next.width && box.height === next.height) {
      return next;
    }
    box = next;
  }
  throw new Error(`${label} box did not settle`);
}

async function expectHitTestOnElement(el: Locator, label: string): Promise<void> {
  const hit = await el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!at) return 'none';
    return at === node || node.contains(at) || at.contains(node) ? 'self' : `other:${at.tagName}.${(at as HTMLElement).className}`;
  });
  expect(hit, `${label} elementFromPoint hit ${hit}`).toBe('self');
}

test.describe('composer popover 矮视口限高', () => {
  test.use({ viewport: { width: 900, height: 500 } });

  test('/ 面板：顶边不出聊天区，首行可见、命中、可点', async ({ page }, testInfo) => {
    const editor = await openComposer(page);
    await growComposer(page, editor, 30);
    await page.keyboard.press(' ');
    await page.keyboard.press('/');

    const popover = page.locator('[data-slash-command-popover]');
    await expect(popover).toBeVisible({ timeout: 10_000 });

    const pop = await settledBox(popover, 'slash popover');
    const boundary = await boundaryTop(page);
    console.log(JSON.stringify({ step: 'slash-popover', popover: pop, boundaryTop: boundary }));
    expect(pop).toBeTruthy();
    expect(pop!.y, `popover top ${pop!.y} under boundary ${boundary}`).toBeGreaterThanOrEqual(boundary);
    expect(pop!.y).toBeGreaterThanOrEqual(0);

    const firstRow = popover.locator('[data-slash-command-id]').first();
    const rowId = await firstRow.getAttribute('data-slash-command-id');
    const rowBox = await firstRow.boundingBox();
    console.log(JSON.stringify({ step: 'slash-first-row', rowId, row: rowBox, popoverTop: pop!.y }));
    expect(rowBox).toBeTruthy();
    // 第一行完整落在 popover 内（顶部不被裁）
    expect(rowBox!.y).toBeGreaterThanOrEqual(pop!.y);
    expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(pop!.y + pop!.height);
    await expectHitTestOnElement(firstRow, `first slash row ${rowId}`);

    // 列表内部滚动到顶后点击第一行：选中即关面板（handleSlashCommandSelect 先 setShowSlashPopover(false)）
    await popover.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await popover.evaluate((el) => { el.scrollTop = 0; });
    await expectHitTestOnElement(firstRow, `first slash row ${rowId} after scroll-to-top`);
    await page.screenshot({ path: testInfo.outputPath('fb3234-slash-popover-900x500.png') });
    await firstRow.click();
    await expect(popover).toBeHidden({ timeout: 10_000 });
  });

  test('@ 面板：搜索提示与分类 tab 完整可见、命中、可点', async ({ page }, testInfo) => {
    const editor = await openComposer(page);
    await growComposer(page, editor, 30);
    await page.keyboard.press('@');

    const popover = page.locator('[data-at-mention-popover]');
    await expect(popover).toBeVisible({ timeout: 10_000 });

    const pop = await settledBox(popover, '@ popover');
    const boundary = await boundaryTop(page);
    console.log(JSON.stringify({ step: 'at-popover', popover: pop, boundaryTop: boundary }));
    expect(pop).toBeTruthy();
    expect(pop!.y, `@ popover top ${pop!.y} under boundary ${boundary}`).toBeGreaterThanOrEqual(boundary);
    expect(pop!.y).toBeGreaterThanOrEqual(0);

    // 搜索提示（sticky 首行）完整可见
    const hint = popover.locator('div').first();
    const hintBox = await hint.boundingBox();
    expect(hintBox).toBeTruthy();
    expect(hintBox!.y).toBeGreaterThanOrEqual(pop!.y);
    expect(hintBox!.y + hintBox!.height).toBeLessThanOrEqual(pop!.y + pop!.height);
    await expectHitTestOnElement(hint, '@ search hint');

    // 分类 tab 行（All / Library / Files / ...）完整可见、命中、可点
    const tabs = popover.locator('[role="tab"]');
    const tabCount = await tabs.count();
    expect(tabCount).toBeGreaterThanOrEqual(2);
    const tabsRow = popover.locator('[role="tablist"]');
    const tabsBox = await tabsRow.boundingBox();
    expect(tabsBox).toBeTruthy();
    expect(tabsBox!.y).toBeGreaterThanOrEqual(pop!.y);
    expect(tabsBox!.y + tabsBox!.height).toBeLessThanOrEqual(pop!.y + pop!.height);
    const firstTab = tabs.first();
    await expectHitTestOnElement(firstTab, '@ first tab');
    await page.screenshot({ path: testInfo.outputPath('fb3234-at-popover-900x500.png') });
    const secondTab = tabs.nth(1);
    await secondTab.click();
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  });

  test('/agent 面板与 @expert 行内列表（fixture 有专家才走真触发，否则由 vitest 覆盖）', async ({ page }, testInfo) => {
    const editor = await openComposer(page);
    // 这两个触发器都要求触发词在文本开头（'/agent ' 前缀 / 行首 '@query'），
    // 与「先垫 30 行再敲」互斥——trigger 本身约束。矮空间收缩已由 vitest 打桩用例覆盖；
    // 这里走真实触发器验证顶边落在聊天区内。
    await page.keyboard.insertText('/agent ');

    const agentPopover = page.locator('[data-agent-command-autocomplete]');
    const agentOpen = await agentPopover.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
    if (!agentOpen) {
      console.log(JSON.stringify({ step: 'agent-command', skipped: 'fixture has no agent entries; covered by vitest render test' }));
      return;
    }
    const pop = await settledBox(agentPopover, '/agent popover');
    const boundary = await boundaryTop(page);
    console.log(JSON.stringify({ step: 'agent-command-popover', popover: pop, boundaryTop: boundary }));
    expect(pop!.y).toBeGreaterThanOrEqual(boundary);
    expect(pop!.y).toBeGreaterThanOrEqual(0);
    const firstOption = agentPopover.locator('button').first();
    await expectHitTestOnElement(firstOption, 'first /agent option');

    // @expert 行内列表：触发要求文本以 @ 开头；取 /agent 面板首个候选的 token
    const firstToken = await agentPopover.locator('button').first().locator('.font-mono').first().innerText();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await expect(editor).toHaveAttribute('data-plain-text', '');
    await page.keyboard.insertText(`@${firstToken.trim()}`);
    const mentionPopover = page.locator('[data-agent-mention-autocomplete]');
    const mentionOpen = await mentionPopover.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false);
    if (!mentionOpen) {
      console.log(JSON.stringify({ step: 'agent-mention', skipped: 'no mention matches; covered by vitest render test' }));
      return;
    }
    const mPop = await settledBox(mentionPopover, '@expert mention popover');
    console.log(JSON.stringify({ step: 'agent-mention-popover', popover: mPop, boundaryTop: await boundaryTop(page) }));
    expect(mPop!.y).toBeGreaterThanOrEqual(await boundaryTop(page));
    expect(mPop!.y).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath('fb3234-agent-popovers-900x500.png') });
  });
});

test.describe('composer popover 常规视口行为不变', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('1440x900 单行 composer：/ 与 @ 面板仍按旧上限 280 展开', async ({ page }, testInfo) => {
    await openComposer(page);
    await page.keyboard.press('/');

    const slash = page.locator('[data-slash-command-popover]');
    await expect(slash).toBeVisible({ timeout: 10_000 });
    const slashMax = await slash.evaluate((el) => (el as HTMLElement).style.maxHeight);
    console.log(JSON.stringify({ step: 'normal-slash', maxHeight: slashMax }));
    expect(slashMax).toBe('280px');
    await page.screenshot({ path: testInfo.outputPath('fb3234-normal-1440x900-slash.png') });

    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('@');
    const at = page.locator('[data-at-mention-popover]');
    await expect(at).toBeVisible({ timeout: 10_000 });
    const atMax = await at.evaluate((el) => (el as HTMLElement).style.maxHeight);
    console.log(JSON.stringify({ step: 'normal-at', maxHeight: atMax }));
    expect(atMax).toBe('280px');
    await page.screenshot({ path: testInfo.outputPath('fb3234-normal-1440x900-at.png') });
  });
});
