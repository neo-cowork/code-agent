import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../../src/shared/contract';
import { formatPreviewHealthMessage, type PreviewHealthMessageKey } from '../../../../src/shared/i18n/previewHealth';
import type { ContextAssembly } from '../../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../../src/host/agent/runtime/runFinalizer';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import type { ArtifactPreviewHealthSummary } from '../../../../src/host/agent/runtime/browser/artifactPreviewHealth';
import { ArtifactState } from '../../../../src/host/agent/runtime/artifactState';
import { maybeRunWebDeliverablePreviewRepair, finalizeWebDeliverablePreviewRepairs } from '../../../../src/host/agent/runtime/webDeliverablePreviewRepair';

const config = vi.hoisted(() => ({ language: 'zh', throws: false }));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => {
    if (config.throws) throw new Error('settings unavailable');
    return { ui: { language: config.language } };
  } }),
}));
vi.mock('../../../../src/host/platform', () => ({ app: { getLocale: () => 'en-US' } }));
vi.mock('../../../../src/host/agent/runtime/browser/artifactPreviewHealth', () => ({ runArtifactPreviewHealth: vi.fn() }));

const healthy: ArtifactPreviewHealthSummary = { attempted: true, passed: true, findings: [], checks: [], failures: [] };
const broken: ArtifactPreviewHealthSummary = {
  ...healthy, passed: false,
  findings: [
    { code: 'broken_image', message: 'missing', viewport: 'desktop' },
    { code: 'horizontal_overflow', message: 'overflow', viewport: 'mobile' },
  ],
};

function harness() {
  const ctx = { artifact: ArtifactState.forTest(), onEvent: vi.fn() } as unknown as RuntimeContext;
  const persist = vi.fn(async (_message: Message) => {});
  const contextAssembly = { generateId: () => 'notice', addAndPersistMessage: persist, injectSystemMessage: vi.fn() } as unknown as ContextAssembly;
  const progress = vi.fn();
  const healthRunner = vi.fn().mockResolvedValue(broken);
  const check = () => maybeRunWebDeliverablePreviewRepair({
    ctx, contextAssembly, runFinalizer: { emitTaskProgress: progress } as unknown as RunFinalizer,
    healthRunner, absolutePath: '/tmp/page.html',
    toolCall: { id: 'write', name: 'Write', arguments: {} }, toolResult: { toolCallId: 'write', success: true },
  });
  const print = () => {
    for (const [message] of persist.mock.calls) console.log('persisted system content:', message.content);
    for (const [, text] of progress.mock.calls) console.log('emitTaskProgress:', text);
  };
  return { ctx, persist, progress, healthRunner, check, print };
}

beforeEach(() => { config.language = 'zh'; config.throws = false; });

const text = {
  zh: {
    notice: '网页交付物预览发现 2 个显示问题，正在自动修复…',
    fixed: '网页显示问题已修好',
    remaining: '网页仍有 2 个问题：图片无法显示、内容超出页面宽度',
    unavailable: '未能体检这个网页（预览检查不可用）',
  },
  en: {
    notice: 'Found 2 display problem(s) in the web deliverable preview, repairing...',
    fixed: 'Display problem(s) in the web deliverable were fixed automatically',
    remaining: '2 display problem(s) remain in the web page: images cannot be displayed, content wider than the page',
    unavailable: 'Could not check this web page (preview check unavailable)',
  },
};

describe.each(['zh', 'en'] as const)('UI %s with OS en-US', (language) => {
  beforeEach(() => { config.language = language; });
  it('webRepairNotice follows UI language', async () => {
    const h = harness(); await h.check();
    expect(h.progress).toHaveBeenCalledWith('tool_running', text[language].notice);
    expect(h.persist).not.toHaveBeenCalled(); // Initial notice is progress-only in production.
    h.print();
  });
  it.each(['fixed', 'remaining'] as const)('webRepair %s follows UI language with localized categories', async (outcome) => {
    const h = harness(); await h.check();
    h.healthRunner.mockResolvedValue(outcome === 'fixed' ? healthy : broken);
    await finalizeWebDeliverablePreviewRepairs(h.ctx);
    expect(h.persist).toHaveBeenCalledWith(expect.objectContaining({
      role: 'system', content: `page.html: ${text[language][outcome]}`,
      metadata: { agentRecoveryNotice: { kind: 'web_preview_repair' } },
    }));
    expect(h.progress).toHaveBeenLastCalledWith('tool_running', text[language][outcome]);
    if (language === 'zh') expect(h.persist.mock.calls[0][0].content).not.toContain('display problem(s)');
    h.print();
  });
  it.each(['crashed', 'skipped', 'checkerFailed'] as const)('webRepairUnavailable follows UI language for %s', async (failure) => {
    const h = harness();
    if (failure === 'crashed') h.healthRunner.mockRejectedValue(new Error('checker crashed'));
    else h.healthRunner.mockResolvedValue({ ...healthy, [failure]: true });
    await h.check();
    expect(h.persist).toHaveBeenCalledWith(expect.objectContaining({ role: 'system', content: `page.html: ${text[language].unavailable}` }));
    expect(h.progress).not.toHaveBeenCalled();
    h.print();
  });
});

it('defaults to Chinese without throwing when settings cannot be read', async () => {
  config.throws = true;
  const h = harness(); await h.check();
  expect(h.progress).toHaveBeenCalledWith('tool_running', text.zh.notice);
});

it('formats every PreviewHealthMessageKey in both tables with identical key coverage', () => {
  const keys = {
    categorySeparator: true, skipped: true, routeInAppPassed: true, routeInAppFindings: true,
    routeFallback: true, routeSelfStartedPassed: true, inspectedViewports: true, unableToRun: true,
    webServerUnavailable: true, inAppUnavailable: true, webRepairNotice: true, webRepairFixed: true,
    webRepairRemaining: true, webRepairUnavailable: true, blank_body_text: true, horizontal_overflow: true,
    console_error: true, page_error: true, broken_image: true, missing_main_element: true,
    primary_button_not_visible: true, responsive_breakpoint_failure: true, html_incomplete: true, button_no_response: true,
  } satisfies Record<PreviewHealthMessageKey, true>;
  for (const key of Object.keys(keys) as PreviewHealthMessageKey[]) {
    for (const locale of ['zh', 'en']) {
      expect(formatPreviewHealthMessage(key, { count: 2, reason: 'reason', provider: 'provider', categories: 'categories' }, locale)).not.toBe('');
    }
  }
  console.log('key parity:', Object.keys(keys).length, 'keys formatted in zh and en');
});
