import { describe, expect, it } from 'vitest';
import { resolveBrowserEmptyText } from '../../../src/renderer/components/workbench/browserAgentWindowEmptyText';
import { workbenchTabsZh } from '../../../src/renderer/i18n/workbenchTabs';

const copy = workbenchTabsZh.workbenchTabs.agentWindow as unknown as Parameters<typeof resolveBrowserEmptyText>[0];
const base = { repairNeeded: false, streaming: false, streamUnavailable: false, running: false, activeUrl: null };

describe('resolveBrowserEmptyText', () => {
  it('says the work is in the background browser when it runs but the tab is still blank', () => {
    for (const activeUrl of ['about:blank', '', null]) {
      const text = resolveBrowserEmptyText(copy, { ...base, running: true, activeUrl });
      expect(text.title).toBe('Neo 正在后台浏览器里操作');
      expect(text.title).not.toContain('还没开始');
    }
  });

  it('keeps the idle copy when nothing is running, and defers to repair/stream states', () => {
    expect(resolveBrowserEmptyText(copy, base).title).toBe('Neo 还没开始操作网页');
    expect(resolveBrowserEmptyText(copy, { ...base, running: true, activeUrl: 'about:blank', repairNeeded: true }).title).toBe('浏览器还没准备好');
    expect(resolveBrowserEmptyText(copy, { ...base, running: true, activeUrl: 'about:blank', streaming: true }).title).toBe('正在接入现场…');
  });
});
