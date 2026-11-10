// get_dom_snapshot compact model output (N-FIX-BROWSER-TASK-CONTEXT-BLOAT-SNAPSHOT)
// Real browserActionTool + real BrowserService (headless bundled Chromium) + real resolveTargetRef.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserService } from '../../../../src/host/services/infra/browserService';
import { browserActionTool } from '../../../../src/host/tools/vision/browserAction';
import { BROWSER_SNAPSHOT } from '../../../../src/shared/constants';
import type { ToolContext } from '../../../../src/host/tools/types';

const context: ToolContext = {
  workingDirectory: process.cwd(),
  sessionId: 'dom-snapshot-compact',
  requestPermission: async () => true,
  executionIntent: {
    browserSessionMode: 'managed',
    preferBrowserSession: true,
    allowBrowserAutomation: true,
    browserSessionSnapshot: { ready: true },
  },
} as ToolContext;

const dataUrl = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
const run = (params: Record<string, unknown>) => browserActionTool.execute(params, context);

const LONG = 'x'.repeat(70);
const bigPage = dataUrl(`<!doctype html><title>Big</title><h1>Big page</h1>${
  Array.from({ length: 120 }, (_, i) => `<a href="#l${i}">item${String(i).padStart(3, '0')} ${LONG}</a>`).join('<br>')
}`);
const smallPage = dataUrl(`<!doctype html><title>Small</title><h1>Small</h1>
<button id="b" onclick="document.title='clicked';document.getElementById('o').textContent='done'">Press me</button><p id="o">idle</p>`);

describe('browser_action get_dom_snapshot compact output', () => {
  beforeAll(async () => {
    await browserService.close().catch(() => undefined);
    await browserService.launch({ mode: 'headless' } as never);
  }, 60_000);
  afterAll(async () => {
    await browserService.close().catch(() => undefined);
  });

  it('emits one refId line per element, no per-line selector/rect JSON, and a summary-only metadata', async () => {
    await run({ action: 'navigate', url: smallPage });
    const r = await run({ action: 'get_dom_snapshot' });
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/^tref_\S+ \| button \| Press me$/m);
    expect(r.output).not.toContain('selectorHint');
    expect(r.output).not.toContain('backendNodeId');
    expect(r.output!.length).toBeLessThanOrEqual(BROWSER_SNAPSHOT.MAX_CHARS);
    const dom = r.metadata!.domSnapshot as Record<string, unknown>;
    expect(dom.interactiveElements).toBeUndefined();
    expect(dom.interactiveCount).toBe(1);
    expect(dom.headingCount).toBe(1);
  }, 60_000);

  it('click with only the refId string from the compact output resolves and acts on the live page', async () => {
    await run({ action: 'navigate', url: smallPage });
    const r = await run({ action: 'get_dom_snapshot' });
    const refId = r.output!.match(/^(tref_\S+) \| button \| Press me$/m)![1];
    const click = await run({ action: 'click', targetRef: refId });
    expect(click.success, click.error).toBe(true);
    const content = await run({ action: 'get_content' });
    expect(content.output).toContain('done');
  }, 60_000);

  it('stops at the char budget with a "+K more" line and offset returns the next elements', async () => {
    await run({ action: 'navigate', url: bigPage });
    const first = await run({ action: 'get_dom_snapshot' });
    expect(first.success).toBe(true);
    expect(first.output!.length).toBeLessThanOrEqual(BROWSER_SNAPSHOT.MAX_CHARS);
    const last = first.output!.trim().split('\n').pop()!;
    const m = last.match(/^\+(\d+) more elements, call get_dom_snapshot with offset=(\d+)$/);
    expect(m, last).not.toBeNull();
    const offset = Number(m![2]);
    const shownFirst = first.output!.split('\n').filter((l) => l.startsWith('tref_')).length;
    expect(offset).toBe(shownFirst);
    expect(Number(m![1])).toBe(80 - shownFirst);

    const next = await run({ action: 'get_dom_snapshot', offset });
    const nextLines = next.output!.split('\n').filter((l) => l.startsWith('tref_'));
    expect(nextLines.length).toBeGreaterThan(0);
    expect(nextLines[0]).toContain(`item${String(offset).padStart(3, '0')}`);
    expect(next.output).not.toContain('headings:');
  }, 60_000);
});
