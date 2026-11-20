import { beforeEach, describe, expect, it, vi } from 'vitest';

const locale = vi.hoisted(() => ({ value: 'zh' as 'zh' | 'en' }));
vi.mock('../../../../src/host/config/hostUiLocale', () => ({ getHostUiLocale: () => locale.value }));

const registry = vi.hoisted(() => ({ state: 'none' as 'none' | 'kept' | 'closed' }));
vi.mock('../../../../src/host/services/surfaceExecution/keptBrowserRegistry', () => ({
  getKeptBrowserRegistry: () => ({ snapshot: () => ({ state: registry.state }) }),
}));

import { applyBrowserKeepClaimGate } from '../../../../src/host/agent/runtime/browserKeepClaimGate';
import { BROWSER_KEEP_CLAIM_GATE_WARNING } from '../../../../src/shared/i18n/browserKeepClaimGateWarning';

const base = { sessionId: 's1', usedBrowserTool: true, retriesDone: 0 };

describe('applyBrowserKeepClaimGate', () => {
  beforeEach(() => { registry.state = 'none'; locale.value = 'zh'; });

  it('retries a "window stays open" claim when nothing is kept (leave-it-to-me wording)', async () => {
    const r = await applyBrowserKeepClaimGate({ ...base, recentUserMessages: ['订好会议室，把结果页留给我'], assistantContent: '已订好，窗口会停留在这个结果页，没有关闭。' });
    expect(r.action).toBe('retry');
    expect(r.reason).toBe('browser_keep_claim_without_kept_entry:retry:browser_tool_used');
    expect(r.repairPrompt).toContain('keep_result_page');
  });

  it('warns on the second hit and prefixes the localized warning', async () => {
    const r = await applyBrowserKeepClaimGate({ ...base, retriesDone: 1, assistantContent: '窗口还开着，你可以直接看。' });
    expect(r.action).toBe('warn');
    expect(r.content.startsWith(BROWSER_KEEP_CLAIM_GATE_WARNING.zh)).toBe(true);
    expect(r.reason).toContain(':warn:');
    locale.value = 'en';
    const en = await applyBrowserKeepClaimGate({ ...base, retriesDone: 1, assistantContent: 'The window is still open for you.' });
    expect(en.content.startsWith(BROWSER_KEEP_CLAIM_GATE_WARNING.en)).toBe(true);
  });

  it('catches the follow-up wording without a browser tool call in this run', async () => {
    const r = await applyBrowserKeepClaimGate({ sessionId: 's1', usedBrowserTool: false, retriesDone: 0, recentUserMessages: ['那个窗口真的留着吗', '把结果页留给我'], assistantContent: '是的，窗口保留着，没有关闭。' });
    expect(r.action).toBe('retry');
    expect(r.reason).toContain('user_text_mentions_browser');
  });

  it('does nothing when the registry holds a live kept entry', async () => {
    registry.state = 'kept';
    expect((await applyBrowserKeepClaimGate({ ...base, assistantContent: '窗口保留着，你可以继续操作。' })).action).toBe('none');
  });

  it('does nothing for an honest denial', async () => {
    expect((await applyBrowserKeepClaimGate({ ...base, assistantContent: '窗口已经关闭了，我没能保留结果页，可以重新打开。' })).action).toBe('none');
    expect((await applyBrowserKeepClaimGate({ ...base, assistantContent: 'The window was closed; I could not keep it open.' })).action).toBe('none');
  });

  it('does not mistake a plain page report for a keep claim (real-run false positive: 停留在原页面)', async () => {
    const text = '点击「提交预订」后页面没有跳转到结果页，仍停留在原页面，成功提示直接显示在表单下方。页面标题为「会议室预订」。';
    expect((await applyBrowserKeepClaimGate({ ...base, assistantContent: text })).action).toBe('none');
  });

  it('accepts the honest reply a model gives after the repair prompt (real-run text)', async () => {
    const text = '没留着——那次浏览是后台任务临时打开的，跑完就关了，所以现在没有窗口还开着。要留页面的话，我可以重新打开一次。';
    expect((await applyBrowserKeepClaimGate({ ...base, retriesDone: 1, assistantContent: text })).action).toBe('none');
  });

  it('does nothing for unrelated chat or non-browser context', async () => {
    expect((await applyBrowserKeepClaimGate({ ...base, assistantContent: '好的，已经帮你改完了。' })).action).toBe('none');
    expect((await applyBrowserKeepClaimGate({ sessionId: 's1', usedBrowserTool: false, retriesDone: 0, recentUserMessages: ['改一下代码'], assistantContent: '窗口保留着。' })).action).toBe('none');
  });
});
