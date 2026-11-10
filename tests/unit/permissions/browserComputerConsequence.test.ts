import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import type { ToolDefinition } from '../../../src/shared/contract';

const resolverState = vi.hoisted(() => ({
  definition: undefined as ToolDefinition | undefined,
  execute: vi.fn(),
}));
const loggerState = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: (name: string) => resolverState.definition?.name === name
      ? resolverState.definition
      : undefined,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: loggerState,
  createLogger: () => loggerState,
}));

import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { AgentFailureCode, HostReasonCode } from '../../../src/shared/contract';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { resolveToolPermissionClassification } from '../../../src/host/tools/toolPermissionClassification';
import { browserService } from '../../../src/host/services/infra/browserService';
import { getManagedBrowserProviderAdapter } from '../../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter';

function setSurfaceTool(name: string): void {
  resolverState.definition = {
    name,
    description: 'surface action test tool',
    outputSchema: { type: 'string' },
    inputSchema: { type: 'object', properties: {} },
    requiresPermission: true,
    permissionLevel: 'execute',
  };
}

describe('browser/computer consequence approval tier', () => {
  let permissionRequests: Array<Record<string, unknown>>;
  let executor: ToolExecutor;

  beforeEach(() => {
    resetPermissionModeManager();
    resolverState.definition = undefined;
    resolverState.execute.mockReset().mockResolvedValue({ success: true, output: 'ok' });
    permissionRequests = [];
    executor = new ToolExecutor({
      requestPermission: async (request) => {
        permissionRequests.push(request as unknown as Record<string, unknown>);
        return true;
      },
      workingDirectory: '/test/workspace',
    });
  });

describe('managed-browser submit click classification', () => {
  let page: Page;
  let tabId: string;

  beforeAll(async () => {
    await browserService.launch({
      mode: 'headless',
      profileMode: 'isolated',
      provider: 'playwright-bundled',
    });
    tabId = await browserService.newTab();
    const activeTab = browserService.getActiveTab();
    if (!activeTab) throw new Error('managed browser test tab did not launch');
    page = activeTab.page;
    await page.route('https://forms.example.test/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>classification fixture</title>',
      });
    });
  });

  afterAll(async () => {
    await browserService.close();
  });

  beforeEach(() => {
    loggerState.warn.mockClear();
  });

  async function setPageContent(html: string): Promise<void> {
    await page.goto(`https://forms.example.test/classification?case=${Date.now()}`);
    await page.setContent(html);
  }

  async function classify(params: Record<string, unknown>) {
    return await resolveToolPermissionClassification({
      executionToolName: 'browser_action',
      policyToolName: 'browser_action',
      params,
      policyForcesConfirmation: false,
      boundaryViolation: undefined,
      workingDirectory: '/test/workspace',
      permissionLevel: 'execute',
      permStartTime: 0,
      readOnlyForcesConfirmation: false,
      sessionPermissionMode: 'default',
    });
  }

  it('fill_form then click on a POST form submit control returns ask with the target host', async () => {
    await setPageContent(`
      <form method="post" action="/register">
        <label>Name <input id="name" name="name"></label>
        <button id="go">Go</button>
      </form>
    `);

    expect((await classify({
      action: 'fill_form',
      formData: { '#name': 'Neo' },
      tabId,
    })).decision).toBe('approve');

    const snapshot = await browserService.getDomSnapshot(tabId);
    const targetRef = snapshot.interactiveElements.find(
      (element) => element.selectorHint === '#go',
    )?.targetRef;
    expect(targetRef).toBeDefined();
    const result = await classify({ action: 'click', targetRef, tabId });
    expect(result).toMatchObject({
      decision: 'ask',
      traceStep: { rule: 'browser_computer_consequence', result: 'ask' },
      hostReason: { metadata: { toolName: 'browser_action' } },
    });
    expect(result.reason).toContain('Browser click submits a form');
    expect(result.reason).toContain('POST to forms.example.test');
    expect(result.reason).not.toContain('no external side effect');
  });

  it('click_text on a cross-origin GET form submit control returns ask', async () => {
    await setPageContent(`
      <form method="get" action="https://payments.example.test/checkout">
        <button type="submit">Continue</button>
      </form>
    `);

    const result = await classify({ action: 'click_text', text: 'Continue', tabId });
    expect(result.decision).toBe('ask');
    expect(result.reason).toContain('GET to payments.example.test, cross-origin');
  });

  it.each([
    ['link click', '<a id="target" href="/learn">Learn more</a>'],
    ['expand/collapse button', '<button id="target" type="button" aria-expanded="false">Details</button>'],
    ['input focus click', '<input id="target" name="query">'],
    ['same-origin GET search form', '<form method="get" action="/search"><button id="target">Go</button></form>'],
  ])('%s stays approved', async (_label, html) => {
    await setPageContent(html);
    expect((await classify({ action: 'click', selector: '#target', tabId })).decision).toBe('approve');
  });

  it('probe failure plus Submit text asks and logs the fallback cause', async () => {
    const result = await classify({
      action: 'click_text',
      text: 'Submit',
      tabId: 'missing-tab',
    });

    expect(result.decision).toBe('ask');
    expect(loggerState.warn).toHaveBeenCalledWith(
      'Browser click submit probe unavailable; applying argument heuristic',
      expect.objectContaining({
        action: 'click_text',
        cause: expect.stringContaining('Tab not found'),
        heuristicMatched: true,
      }),
    );
  });

  it('probe failure plus Next text stays approved and logs the fallback cause', async () => {
    const result = await classify({
      action: 'click_text',
      text: 'Next',
      tabId: 'missing-tab',
    });

    expect(result.decision).toBe('approve');
    expect(loggerState.warn).toHaveBeenCalledWith(
      'Browser click submit probe unavailable; applying argument heuristic',
      expect.objectContaining({
        action: 'click_text',
        cause: expect.stringContaining('Tab not found'),
        heuristicMatched: false,
      }),
    );
  });

  it('ToolExecutor probes the run-owned managed browser before dispatch', async () => {
    const identity = {
      conversationId: 'submit-probe-session',
      runId: 'submit-probe-run',
      turnId: 'submit-probe-turn',
      agentId: 'submit-probe-agent',
    };
    const runBrowser = getManagedBrowserProviderAdapter().getBrowserService(identity);
    await runBrowser.launch({
      mode: 'headless',
      profileMode: 'isolated',
      provider: 'playwright-bundled',
    });
    try {
      await runBrowser.newTab();
      const runPage = runBrowser.getActiveTab()?.page;
      if (!runPage) throw new Error('run-owned managed browser test tab did not launch');
      await runPage.setContent(`
        <form method="post" action="https://run-owned.example.test/register">
          <button id="run-owned-go">Go</button>
        </form>
      `);
      setSurfaceTool('Browser');

      const result = await executor.execute(
        'Browser',
        { action: 'click', selector: '#run-owned-go' },
        {
          sessionId: identity.conversationId,
          runId: identity.runId,
          turnId: identity.turnId,
          agentId: identity.agentId,
        },
      );

      expect(result.success).toBe(true);
      expect(permissionRequests).toHaveLength(1);
      expect(permissionRequests[0].tool).toBe('Browser');
      expect(permissionRequests[0].decisionTrace).toMatchObject({
        steps: expect.arrayContaining([expect.objectContaining({
          rule: 'browser_computer_consequence',
          result: 'ask',
        })]),
      });
    } finally {
      await runBrowser.close();
    }
  });

  it('submit ask has the same result shape as a catalog external_side_effect ask', async () => {
    await setPageContent(`
      <form method="post" action="/register"><button id="go">Go</button></form>
    `);
    const submit = await classify({ action: 'click', selector: '#go', tabId });
    const existing = await classify({ action: 'write_clipboard', clipboardText: 'value' });

    expect(submit.decision).toBe('ask');
    expect(Object.keys(submit).sort()).toEqual(Object.keys(existing).sort());
    expect(Object.keys(submit.hostReason ?? {}).sort()).toEqual(
      Object.keys(existing.hostReason ?? {}).sort(),
    );
    expect(Object.keys(submit.traceStep ?? {}).sort()).toEqual(
      Object.keys(existing.traceStep ?? {}).sort(),
    );
    expect(submit).toMatchObject({
      decision: 'ask',
      traceStep: { rule: 'browser_computer_consequence', result: 'ask' },
      hostReason: { metadata: { toolName: 'browser_action' } },
    });
  });
});

  it('default: a browser action without external side effects runs without approval', async () => {
    setSurfaceTool('browser_action');
    const result = await executor.execute('browser_action', { action: 'click', selector: '#details' }, {});
    expect(result.success).toBe(true);
    expect(permissionRequests).toHaveLength(0);
  });

  it('default: an external-side-effect browser action requests approval', async () => {
    setSurfaceTool('browser_action');
    const result = await executor.execute('browser_action', {
      action: 'upload_file',
      selector: '#attachment',
      uploadFilePath: '/tmp/report.pdf',
    }, {});
    expect(result.success).toBe(true);
    expect(permissionRequests).toHaveLength(1);
  });

  it('default: a high-risk browser action is denied without prompting or dispatching', async () => {
    setSurfaceTool('browser_action');
    const result = await executor.execute('browser_action', { action: 'clear_cookies' }, {});
    expect(result).toMatchObject({
      success: false,
      metadata: {
        code: 'BROWSER_COMPUTER_HIGH_RISK_BLOCKED',
        failureCode: AgentFailureCode.PermissionDenied,
        hostReason: { code: HostReasonCode.PermissionHighRiskActionBlocked },
      },
    });
    expect(result.error).toBe(
      'Denied: High-risk browser/computer action is blocked by policy: browser_action.clear_cookies',
    );
    expect(permissionRequests).toHaveLength(0);
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'upload_file', uploadFilePath: '/tmp/report.pdf' },
    { action: 'write_clipboard', clipboardText: 'sensitive value' },
    { action: 'handle_dialog', dialogAction: 'accept', dialogPromptText: 'sensitive value' },
  ])('keeps existing upload/clipboard/dialog approval gates active: $action', async (params) => {
    setSurfaceTool('browser_action');
    expect((await executor.execute('browser_action', params, {})).success).toBe(true);
    expect(permissionRequests).toHaveLength(1);
  });

  it.each([
    { action: 'click', selector: '#details' },
    { action: 'navigate', url: 'http://127.0.0.1/' },
    { action: 'get_content' },
    { action: 'type', selector: '#q', text: 'hi' },
  ])('Browser tool: ordinary action runs without approval: $action', async (params) => {
    setSurfaceTool('Browser');
    expect((await executor.execute('Browser', params, {})).success).toBe(true);
    expect(permissionRequests).toHaveLength(0);
  });

  it.each([
    { action: 'upload_file', uploadFilePath: '/tmp/report.pdf' },
    { action: 'open', url: 'http://127.0.0.1/' },
  ])('Browser tool: external-side-effect action asks exactly once: $action', async (params) => {
    setSurfaceTool('Browser');
    expect((await executor.execute('Browser', params, {})).success).toBe(true);
    expect(permissionRequests).toHaveLength(1);
  });

  it('Browser tool: an unregistered action is denied by the catalog', async () => {
    setSurfaceTool('Browser');
    const result = await executor.execute('Browser', { action: 'frobnicate' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('not registered in the consequence catalog');
    expect(result.metadata).toMatchObject({
      hostReason: { code: HostReasonCode.PermissionUnregisteredActionBlocked },
    });
    expect(permissionRequests).toHaveLength(0);
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it('Browser tool: a high-risk catalog entry stays denied', async () => {
    setSurfaceTool('Browser');
    const result = await executor.execute('Browser', { action: 'clear_cookies' }, {});
    expect(result.success).toBe(false);
    expect(result.metadata).toMatchObject({
      hostReason: { code: HostReasonCode.PermissionHighRiskActionBlocked },
    });
    expect(permissionRequests).toHaveLength(0);
  });

  it('covers stateful computer_use, Computer alias, and gui_agent at the same decision point', async () => {
    setSurfaceTool('computer_use');
    expect((await executor.execute('computer_use', { operation: 'observe' }, {})).success).toBe(true);
    expect(permissionRequests).toHaveLength(0);

    expect((await executor.execute('computer_use', { operation: 'act', stateId: 's1' }, {})).success).toBe(true);
    expect(permissionRequests).toHaveLength(1);

    setSurfaceTool('Computer');
    expect((await executor.execute('Computer', { action: 'screenshot' }, {})).success).toBe(true);
    expect(permissionRequests).toHaveLength(1);

    setSurfaceTool('gui_agent');
    expect((await executor.execute('gui_agent', { task: 'Open Settings' }, {})).success).toBe(true);
    expect(permissionRequests).toHaveLength(2);
  });

  it('fails closed when a surface action is absent from the catalog', async () => {
    setSurfaceTool('browser_action');
    const result = await executor.execute('browser_action', { action: 'future_action' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('not registered in the consequence catalog');
    expect(permissionRequests).toHaveLength(0);
  });

  it.each(['managed', 'relay'] as const)(
    'does not let skill pre-approval bypass hard denies for the %s engine',
    async (engine) => {
      setSurfaceTool('browser_action');

      const highRiskResult = await executor.execute(
        'browser_action',
        { action: 'clear_cookies', engine },
        { preApprovedTools: new Set(['browser_action']) },
      );
      expect(highRiskResult).toMatchObject({
        success: false,
        metadata: { code: 'BROWSER_COMPUTER_HIGH_RISK_BLOCKED' },
      });

      const unregisteredResult = await executor.execute(
        'browser_action',
        { action: 'future_action', engine },
        { preApprovedTools: new Set(['browser_action']) },
      );
      expect(unregisteredResult.success).toBe(false);
      expect(unregisteredResult.error).toContain('not registered in the consequence catalog');
      expect(permissionRequests).toHaveLength(0);
      expect(resolverState.execute).not.toHaveBeenCalled();
    },
  );

  it.each(['managed', 'relay'] as const)(
    'keeps skill pre-approval active for ordinary ask actions on the %s engine',
    async (engine) => {
      setSurfaceTool('browser_action');

      const result = await executor.execute(
        'browser_action',
        {
          action: 'upload_file',
          engine,
          selector: '#attachment',
          uploadFilePath: '/tmp/report.pdf',
        },
        { preApprovedTools: new Set(['browser_action']) },
      );

      expect(result.success).toBe(true);
      expect(permissionRequests).toHaveLength(0);
      expect(resolverState.execute).toHaveBeenCalledTimes(1);
    },
  );
});
