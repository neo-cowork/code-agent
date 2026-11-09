import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
  ToolModule,
} from '../../../../../src/host/protocol/tools';

const legacyExecute = vi.hoisted(() => ({
  browser: vi.fn(),
  browserAction: vi.fn(),
  browserNavigate: vi.fn(),
  computer: vi.fn(),
  computerUse: vi.fn(),
  screenshot: vi.fn(),
  guiAgent: vi.fn(),
}));

vi.mock('../../../../../src/host/tools/vision/BrowserTool', () => ({
  BrowserTool: { execute: legacyExecute.browser },
}));

vi.mock('../../../../../src/host/tools/vision/browserAction', () => ({
  browserActionTool: { execute: legacyExecute.browserAction },
}));

vi.mock('../../../../../src/host/tools/vision/browserNavigate', () => ({
  browserNavigateTool: { execute: legacyExecute.browserNavigate },
}));

vi.mock('../../../../../src/host/tools/vision/ComputerTool', () => ({
  ComputerTool: { execute: legacyExecute.computer },
}));

vi.mock('../../../../../src/host/tools/vision/computerUse', () => ({
  computerUseTool: { execute: legacyExecute.computerUse },
}));

vi.mock('../../../../../src/host/tools/vision/screenshot', () => ({
  screenshotTool: { execute: legacyExecute.screenshot },
}));

vi.mock('../../../../../src/host/tools/vision/guiAgent', () => ({
  guiAgentTool: { execute: legacyExecute.guiAgent },
}));

import { browserModule } from '../../../../../src/host/plugins/builtin/browserControl/browser';
import { browserActionModule } from '../../../../../src/host/plugins/builtin/browserControl/browserAction';
import { browserNavigateModule } from '../../../../../src/host/plugins/builtin/browserControl/browserNavigate';
import { computerModule } from '../../../../../src/host/plugins/builtin/computerUse/computer';
import { computerUseModule } from '../../../../../src/host/plugins/builtin/computerUse/computerUse';
import { screenshotModule } from '../../../../../src/host/plugins/builtin/computerUse/screenshot';
import { guiAgentModule } from '../../../../../src/host/plugins/builtin/computerUse/guiAgent';

function makeEightyElementBrowserMetadata(): Record<string, unknown> {
  const interactiveElements = Array.from({ length: 80 }, (_, index) => {
    const refId = `browser-ref-${index}`;
    const selector = `main article:nth-of-type(${index + 1}) a[data-index="${index}"]`;
    return {
      tag: index % 2 ? 'a' : 'button',
      role: index % 2 ? 'link' : 'button',
      text: `Headline ${index} with realistic page copy`,
      selectorHint: selector,
      backendNodeId: index + 100,
      rect: { x: index * 3, y: index * 7, width: 180, height: 32 },
      targetRef: {
        refId,
        source: 'dom',
        selector,
        frameId: 'managed-frame-1',
        documentRevision: 'document-revision-1',
        tabId: 'managed-tab-1',
        snapshotId: 'snapshot-1',
        capturedAtMs: 1_700_000_000_000,
        ttlMs: 30_000,
        confidence: 1,
        backendNodeId: index + 100,
      },
    };
  });
  const elementRefs = interactiveElements.map((element) => ({
    kind: 'browser-element',
    ref: element.targetRef.refId,
    stateId: 'surface-state-1',
    tabRef: 'managed-tab-1',
    frameRef: 'managed-frame-1',
    documentRevision: 'document-revision-1',
    backendNodeId: element.backendNodeId,
    role: element.role,
    name: element.text,
    bounds: element.rect,
    selectorFallback: element.selectorHint,
  }));
  const target = {
    kind: 'browser',
    browserInstanceId: 'browser-1',
    windowRef: 'window-1',
    tabRef: 'managed-tab-1',
    documentRevision: 'document-revision-1',
    origin: 'https://example.test',
  };
  return {
    url: 'https://example.test/wiki',
    domSnapshot: {
      snapshotId: 'snapshot-1',
      tabId: 'managed-tab-1',
      capturedAtMs: 1_700_000_000_000,
      url: 'https://example.test/wiki',
      title: 'Example headlines',
      headings: ['Top stories'],
      interactiveElements,
    },
    surfaceObservationV1: {
      version: 1,
      stateId: 'surface-state-1',
      target,
      providerGeneration: 'provider-1',
      observedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_030_000,
      elementRefs,
      evidenceAssetIds: ['dom:snapshot-1'],
      redactionStatus: 'clean',
      lifecycle: 'fresh',
    },
    surfaceExecutionSessionV1: {
      version: 1,
      sessionId: 'surface-session-1',
      conversationId: 'vision-contract-session',
      runId: 'run-1',
      agentId: 'agent-1',
      surface: 'browser',
      provider: 'managed',
      state: 'running',
      activeTarget: target,
    },
    surfaceExecutionEventsV1: [{
      version: 1,
      eventId: 'surface-event-1',
      sequence: 1,
      sessionId: 'surface-session-1',
      conversationId: 'vision-contract-session',
      runId: 'run-1',
      agentId: 'agent-1',
      surface: 'browser',
      phase: 'observe',
      status: 'succeeded',
      userSummary: 'Observed browser',
      evidenceRefs: ['dom:snapshot-1'],
      artifactRefs: [],
      availableControls: ['end_session'],
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_100,
    }],
  };
}

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'vision-contract-session',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('vision wrapper ToolResult contract', () => {
  let tmpDir: string;
  let imagePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vision-result-meta-'));
    imagePath = path.join(tmpDir, 'screen.png');
    await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    Object.values(legacyExecute).forEach((mock) => mock.mockReset());
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it.each([
    {
      label: 'Browser',
      module: browserModule,
      execute: legacyExecute.browser,
      args: { action: 'screenshot', url: 'https://example.test/app' },
      metadata: () => ({ path: imagePath, legacyFlag: 'browser' }),
      expectedAction: 'screenshot',
      expectedTarget: 'https://example.test/app',
      expectedArtifactKind: 'image',
    },
    {
      label: 'browser_action',
      module: browserActionModule,
      execute: legacyExecute.browserAction,
      args: {
        action: 'get_content',
        url: 'https://example.test/page',
        apiKey: 'secret-value',
      },
      metadata: () => ({
        url: 'https://example.test/page',
        content: 'Rendered page content',
        legacyFlag: 'browser-action',
      }),
      expectedAction: 'get_content',
      expectedTarget: 'https://example.test/page',
      expectedArtifactKind: 'web',
    },
    {
      label: 'browser_navigate',
      module: browserNavigateModule,
      execute: legacyExecute.browserNavigate,
      args: { action: 'open', url: 'https://example.test/nav' },
      metadata: () => ({ url: 'https://example.test/nav', legacyFlag: 'browser-navigate' }),
      expectedAction: 'open',
      expectedTarget: 'https://example.test/nav',
      expectedArtifactKind: 'web',
    },
    {
      label: 'Computer',
      module: computerModule,
      execute: legacyExecute.computer,
      args: { action: 'screenshot', target: 'screen' },
      metadata: () => ({ screenshotPath: imagePath, legacyFlag: 'computer' }),
      expectedAction: 'screenshot',
      expectedTarget: 'screen',
      expectedArtifactKind: 'image',
    },
    {
      label: 'computer_use',
      module: computerUseModule,
      execute: legacyExecute.computerUse,
      args: { action: 'observe', targetApp: 'Safari', includeScreenshot: true },
      metadata: () => ({ file: imagePath, legacyFlag: 'computer-use' }),
      expectedAction: 'observe',
      expectedTarget: 'Safari',
      expectedArtifactKind: 'image',
    },
    {
      label: 'screenshot',
      module: screenshotModule,
      execute: legacyExecute.screenshot,
      args: { target: 'screen' },
      metadata: () => ({ legacyFlag: 'screenshot' }),
      outputPath: () => imagePath,
      expectedAction: 'capture',
      expectedTarget: 'screen',
      expectedArtifactKind: 'image',
    },
    {
      label: 'gui_agent',
      module: guiAgentModule,
      execute: legacyExecute.guiAgent,
      args: { task: 'Click the submit button and report the result' },
      metadata: () => ({ path: imagePath, legacyFlag: 'gui-agent' }),
      expectedAction: 'run',
      expectedTarget: undefined,
      expectedArtifactKind: 'image',
    },
  ] satisfies Array<{
    label: string;
    module: ToolModule<Record<string, unknown>, string>;
    execute: ReturnType<typeof vi.fn>;
    args: Record<string, unknown>;
    metadata: () => Record<string, unknown>;
    outputPath?: () => string;
    expectedAction: string;
    expectedTarget: unknown;
    expectedArtifactKind: string;
  }>)(
    'adds structured meta and artifacts for $label success results',
    async ({ module, execute, args, metadata, outputPath, expectedAction, expectedTarget, expectedArtifactKind }) => {
      const legacyMetadata = metadata();
      execute.mockResolvedValueOnce({
        success: true,
        output: 'legacy ok',
        outputPath: outputPath?.(),
        metadata: legacyMetadata,
      });

      const handler = await module.createHandler();
      const result = await handler.execute(args, makeCtx(), allowAll);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.output).toBe('legacy ok');
      expect(result.meta).toMatchObject({
        tool: module.schema.name,
        action: expectedAction,
        target: expectedTarget,
        request: expect.any(Object),
      });
      expect(result.meta).not.toHaveProperty('legacyMetadata');
      expect(result.meta?.legacyFlag).toBe(legacyMetadata.legacyFlag);
      expect(result.meta?.artifact).toMatchObject({
        kind: expectedArtifactKind,
        sourceTool: module.schema.name,
        sessionId: 'vision-contract-session',
      });
      expect(result.meta?.artifacts).toEqual(expect.arrayContaining([result.meta?.artifact]));
    },
  );

  it('redacts sensitive request args while preserving legacy metadata', async () => {
    legacyExecute.browserAction.mockResolvedValueOnce({
      success: true,
      output: 'legacy ok',
      metadata: {
        url: 'https://example.test/redacted',
        legacyFlag: 'kept',
      },
    });

    const handler = await browserActionModule.createHandler();
    const result = await handler.execute(
      { action: 'navigate', url: 'https://example.test/redacted', apiKey: 'top-secret' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta?.legacyFlag).toBe('kept');
    expect(result.meta?.request).toMatchObject({
      args: {
        apiKey: { redacted: true, length: 'top-secret'.length },
      },
    });
  });

  it('keeps structured action, target, legacy metadata, and evidence artifacts on failures', async () => {
    legacyExecute.computerUse.mockResolvedValueOnce({
      success: false,
      error: 'Computer Surface observe blocked.',
      metadata: {
        code: 'COMPUTER_SURFACE_BLOCKED',
        computerSurfaceSnapshot: { screenshotPath: imagePath },
        workbenchTrace: {
          id: 'trace-1',
          action: 'observe',
          screenshotPath: imagePath,
        },
      },
    });

    const handler = await computerUseModule.createHandler();
    const result = await handler.execute(
      { action: 'observe', targetApp: 'Safari', includeScreenshot: true },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Computer Surface observe blocked');
    expect(result.meta).toMatchObject({
      tool: 'computer_use',
      action: 'observe',
      target: 'Safari',
      code: 'COMPUTER_SURFACE_BLOCKED',
    });
    expect(result.meta).not.toHaveProperty('legacyMetadata');
    expect(result.meta?.artifact).toMatchObject({
      kind: 'image',
      sourceTool: 'computer_use',
      path: imagePath,
    });
    expect(result.meta?.artifacts).toHaveLength(1);
  });

  it('normalizes browser artifact summaries without depending on legacy-only fields', async () => {
    legacyExecute.browserAction.mockResolvedValueOnce({
      success: true,
      output: 'Download completed',
      metadata: {
        browserArtifact: {
          artifactId: 'download_1',
          kind: 'download',
          name: 'report.csv',
          artifactPath: 'report.csv',
          size: 128,
          mimeType: 'text/csv',
          sha256: 'abc123',
          createdAtMs: 1_700_000_000_000,
          sessionId: 'managed-browser-session',
        },
      },
    });

    const handler = await browserActionModule.createHandler();
    const result = await handler.execute(
      { action: 'wait_for_download', selector: '#export' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta?.artifact).toMatchObject({
      artifactId: 'download_1',
      kind: 'text',
      sourceTool: 'browser_action',
      name: 'report.csv',
      mimeType: 'text/csv',
      sizeBytes: 128,
      sha256: 'abc123',
    });
    const artifact = result.meta?.artifact as { metadata?: Record<string, unknown> } | undefined;
    expect(artifact?.metadata).toMatchObject({
      sourceKey: 'browserArtifact',
      legacyBrowserArtifact: expect.objectContaining({ artifactId: 'download_1' }),
    });
  });

  it('bounds persisted 80-element browser metadata through the public handler', async () => {
    const metadata = makeEightyElementBrowserMetadata();
    legacyExecute.browserAction.mockResolvedValueOnce({
      success: true,
      output: JSON.stringify(metadata.domSnapshot),
      metadata,
    });

    const handler = await browserActionModule.createHandler();
    const result = await handler.execute(
      { action: 'get_dom_snapshot' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.meta);
    expect(serialized.length).toBeLessThan(60_000);
    expect(result.meta).not.toHaveProperty('legacyMetadata');
    expect(result.meta?.domSnapshot).toEqual(metadata.domSnapshot);
    expect(result.meta?.surfaceObservationV1).toMatchObject({
      stateId: 'surface-state-1',
      target: metadata.surfaceObservationV1 && (metadata.surfaceObservationV1 as Record<string, unknown>).target,
      elementCount: 80,
      elementKinds: ['browser-element'],
      evidenceAssetIds: ['dom:snapshot-1'],
      redactionStatus: 'clean',
    });
    expect(result.meta?.surfaceObservationV1).not.toHaveProperty('elementRefs');
  });
});
