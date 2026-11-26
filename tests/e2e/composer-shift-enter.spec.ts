import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from './fixtures/axeTest';

const assistantReply = 'The weekly report outline is ready.';

async function openComposer(page: Page, withReply: boolean): Promise<Locator> {
  await page.goto('/');
  const skip = page.getByRole('button', { name: /跳过，稍后在设置里配置|Skip for now/ });
  await skip.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  if (await skip.isVisible()) await skip.click();

  if (withReply) {
    const token = await page.evaluate(() => Reflect.get(window, '__CODE_AGENT_TOKEN__') as string);
    expect(token).toBeTruthy();
    const headers = { Authorization: `Bearer ${token}` };
    const session = await page.request.post('/api/sessions', { data: { title: 'Weekly report' }, headers });
    expect(session.ok()).toBe(true);
    const { data: { id: sessionId } } = await session.json() as { data: { id: string } };
    const now = Date.now();
    const seed = await page.request.post('/api/dev/seed-messages', {
      headers,
      data: {
        sessionId,
        messages: [
          { id: randomUUID(), role: 'user', content: 'Outline my weekly report.', timestamp: now - 1000 },
          { id: randomUUID(), role: 'assistant', content: assistantReply, timestamp: now },
        ],
      },
    });
    expect(seed.ok()).toBe(true);
    await page.locator(`[data-session-id="${sessionId}"]`).first().click();
    await expect(page.getByText(assistantReply, { exact: true })).toBeVisible();
  } else {
    await page.getByRole('button', { name: /^(新任务|New task)/ }).click();
    await expect(page.getByTestId('chat-welcome-title')).toBeVisible();
  }

  const editor = page.getByTestId('chat-composer-textarea');
  await editor.click();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  return editor;
}

async function readEditor(editor: Locator) {
  return editor.evaluate((root) => {
    const selection = window.getSelection();
    const caret = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const tops: Partial<Record<'A' | 'B', number>> = {};
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('[data-composer-chip-key]')) continue;
      for (const char of ['A', 'B'] as const) {
        const offset = node.textContent?.indexOf(char) ?? -1;
        if (offset < 0 || tops[char] !== undefined) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        tops[char] = range.getBoundingClientRect().top;
      }
    }
    return {
      plain: root.getAttribute('data-plain-text'),
      whiteSpace: getComputedStyle(root).whiteSpace,
      nodes: Array.from(root.childNodes, (node) => node.nodeName === '#text' ? node.textContent : node.nodeName),
      focused: document.activeElement === root,
      caretNode: caret?.startContainer.nodeName,
      caretNodeText: caret?.startContainer.nodeType === Node.TEXT_NODE ? caret.startContainer.textContent : null,
      caretOffset: caret?.startOffset,
      caretTop: caret?.getBoundingClientRect().top,
      aTop: tops.A,
      bTop: tops.B,
      chipTop: root.querySelector('[data-composer-chip-key]')?.getBoundingClientRect().top,
    };
  });
}

async function selectInText(editor: Locator, text: string, offset: number): Promise<void> {
  await editor.evaluate((root, { text, offset }) => {
    const node = Array.from(root.childNodes).find((child) =>
      child.nodeType === Node.TEXT_NODE && child.textContent === text);
    if (!node) throw new Error(`No composer text node matching ${text}`);
    window.getSelection()?.collapse(node, offset);
  }, { text, offset });
}

const scenarios = [
  { name: 'new session', initial: 'AAA', before: 'AAA', newline: 'AAA\n', expected: 'AAA\nBBB' },
  { name: 'session with a reply', initial: 'AAA', before: 'AAA', newline: 'AAA\n', expected: 'AAA\nBBB' },
  { name: 'mid-text', initial: 'AAACCC', before: 'AAACCC', newline: 'AAA\nCCC', expected: 'AAA\nBBBCCC' },
  { name: 'after an inline chip', initial: '', before: '', newline: '\n', expected: '\nBBB' },
  { name: 'end of multiline text', initial: 'FIRSTAAA', before: 'FIRST\nAAA', newline: 'FIRST\nAAA\n', expected: 'FIRST\nAAA\nBBB' },
] as const;

for (const scenario of scenarios) {
  test(`Shift+Enter leaves the next text on its new line (${scenario.name})`, async ({ page, browserName }) => {
    const editor = await openComposer(page, scenario.name === 'session with a reply');
    const log = (step: string, state: Awaited<ReturnType<typeof readEditor>>) =>
      console.log(JSON.stringify({ browserName, variant: scenario.name, step, ...state }));

    log('initial', await readEditor(editor));
    for (const key of scenario.initial) {
      await page.keyboard.press(key);
      log(key, await readEditor(editor));
    }
    if (scenario.name === 'mid-text') {
      await selectInText(editor, 'AAACCC', 3);
    }
    if (scenario.name === 'end of multiline text') {
      await selectInText(editor, 'FIRSTAAA', 5);
      await page.keyboard.press('Shift+Enter');
      log('prepare multiline', await readEditor(editor));
      await selectInText(editor, 'AAA', 3);
    }
    if (scenario.name === 'after an inline chip') {
      await editor.locator('xpath=../..').locator('input[type=file]').setInputFiles({
        name: 'weekly-notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Outline for the weekly report.'),
      });
      const chip = editor.locator('[data-composer-chip-kind="file"]');
      await expect(chip).toBeVisible();
      await chip.evaluate((node) => {
        const anchor = node.nextSibling;
        if (!(anchor instanceof Text)) throw new Error('Missing editable text after chip');
        window.getSelection()?.collapse(anchor, anchor.length);
      });
    }

    const before = await readEditor(editor);
    log('before Shift+Enter', before);
    expect(before.plain).toBe(scenario.before);
    await editor.evaluate((root) => {
      function recordShiftEnter(event: KeyboardEvent) {
        if (event.target === root && event.key === 'Enter' && event.shiftKey) {
          document.removeEventListener('keydown', recordShiftEnter);
          console.info(JSON.stringify({ step: 'Shift+Enter keydown', prevented: event.defaultPrevented, trusted: event.isTrusted }));
        }
      }
      document.addEventListener('keydown', recordShiftEnter);
    });
    const keydown = page.waitForEvent('console', { predicate: (message) => message.text().includes('Shift+Enter keydown') });
    await page.keyboard.press('Shift+Enter');
    const keydownLog = (await keydown).text();
    console.log(keydownLog);
    expect(JSON.parse(keydownLog)).toMatchObject({ prevented: true, trusted: true });

    const afterNewline = await readEditor(editor);
    log('after Shift+Enter', afterNewline);
    expect(afterNewline.plain).toBe(scenario.newline);
    for (const key of 'BBB') {
      await page.keyboard.press(key);
      log(key, await readEditor(editor));
    }
    const result = await readEditor(editor);
    expect(result.plain).toBe(scenario.expected);
    const previousLineTop = result.aTop ?? result.chipTop ?? Infinity;
    expect(result.caretTop).toBeGreaterThan(previousLineTop);
    expect(result.bTop).toBeGreaterThan(previousLineTop);
    expect(result.nodes).not.toContain('BR');
    expect(result.nodes).not.toContain('DIV');
  });
}

test('Delete removes the first character after a mid-text Shift+Enter', async ({ page, browserName }) => {
  const editor = await openComposer(page, false);
  await page.keyboard.type('AAACCC');
  await selectInText(editor, 'AAACCC', 3);
  await page.keyboard.press('Shift+Enter');
  const before = await readEditor(editor);
  console.log(JSON.stringify({ browserName, step: 'before Delete', ...before }));
  expect(before.plain).toBe('AAA\nCCC');

  await page.keyboard.press('Delete');
  const after = await readEditor(editor);
  console.log(JSON.stringify({ browserName, step: 'after Delete', ...after }));
  expect(after.plain).toBe('AAA\nCC');
});
