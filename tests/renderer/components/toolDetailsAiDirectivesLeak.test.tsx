import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '@shared/contract';
import type { CanUseToolFn, ToolContext } from '../../../src/host/protocol/tools';

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      openPreview: vi.fn(),
      openSettingsTab: vi.fn(),
    }),
}));

const i18nState = vi.hoisted(() => ({ lang: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh: zhTable } = await import('../../../src/renderer/i18n/zh');
  const { en: enTable } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => (i18nState.lang === 'en'
      ? { t: enTable, language: 'en' }
      : { t: zhTable, language: 'zh' }),
  };
});

import { readModule } from '../../../src/host/tools/modules/file/read';
import { writeModule } from '../../../src/host/tools/modules/file/write';
import { editModule } from '../../../src/host/tools/modules/file/multiEdit';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { ToolExecutionEngine } from '../../../src/host/agent/runtime/toolExecutionEngine';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import { RunStatsState } from '../../../src/host/agent/runtime/runStatsState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';
import { ToolDetails } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails';
import {
  humanizeToolError,
  humanizeToolFailureReason,
} from '../../../src/renderer/utils/toolExecutionPresentation';
import { zh } from '../../../src/renderer/i18n/zh';

const FORBIDDEN_STRINGS = [
  '请直接告诉用户',
  'edit_file',
  '重新生成完整文件',
  'Minimal valid call',
  '完整参数 schema',
  'MemoryRead',
  'memory_search',
  'ToolSearch',
  '槽',
] as const;

const allowAll: CanUseToolFn = async () => ({ allow: true });

function makeCtx(workingDir: string): ToolContext {
  return {
    sessionId: 'test-ai-directives-leak',
    agentId: 'test-agent',
    workingDir,
    abortSignal: new AbortController().signal,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    emit: () => {},
  };
}

function assertNoForbiddenStrings(text: string): void {
  for (const forbidden of FORBIDDEN_STRINGS) {
    expect(text).not.toContain(forbidden);
  }
}

describe('N-FIX-ERROR-CARD-AI-DIRECTIVES-LEAK — renderer cards for all 4 scenes', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(() => {
    savedEnv.HOME = process.env.HOME;
    savedEnv.USERPROFILE = process.env.USERPROFILE;
    savedEnv.CODE_AGENT_DATA_DIR = process.env.CODE_AGENT_DATA_DIR;
    i18nState.lang = 'zh';
  });

  afterEach(() => {
    i18nState.lang = 'zh';
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('Scene 1: expired chat upload Read ENOENT shows plain-language expired upload copy in zh & en without AI directives', async () => {
    const expiredUploadPath = path.join(
      os.tmpdir(),
      'code-agent-uploads',
      '12345678-1234-1234-1234-123456789abc',
      'quarterly-report.csv',
    );
    const handler = await readModule.createHandler();
    const hostResult = await handler.execute(
      { file_path: expiredUploadPath },
      makeCtx(os.tmpdir()),
      allowAll,
    );
    expect(hostResult.ok).toBe(false);
    if (hostResult.ok) return;

    // Model-facing error still contains the AI directive
    expect(hostResult.error).toContain('请直接告诉用户');

    const call: ToolCall = {
      id: 'scene-1-read-expired',
      name: 'Read',
      arguments: { file_path: expiredUploadPath },
      result: {
        toolCallId: 'scene-1-read-expired',
        success: false,
        error: hostResult.error,
        metadata: hostResult.meta,
      },
    };

    const zhMarkup = renderToStaticMarkup(<ToolDetails toolCall={call} />);
    expect(zhMarkup).toContain('这个上传的文件已过期，读取不了');
    expect(zhMarkup).toContain('请重新上传该文件。');
    assertNoForbiddenStrings(zhMarkup);

    const zhSummary = humanizeToolFailureReason(call, zh);
    expect(zhSummary).toBe('请重新上传该文件。');
    assertNoForbiddenStrings(zhSummary ?? '');

    i18nState.lang = 'en';
    const enMarkup = renderToStaticMarkup(<ToolDetails toolCall={call} />);
    expect(enMarkup).toContain('This uploaded file has expired and cannot be read');
    expect(enMarkup).toContain('Please upload the file again.');
    expect(enMarkup).not.toMatch(/[\u4e00-\u9fff]/);
    assertNoForbiddenStrings(enMarkup);
  });

  it('Scene 2: Write and Edit completeness warnings show plain-language note in zh & en without edit_file or 重新生成完整文件', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene2-card-'));
    try {
      // 2a. Real Write result with unclosed brace
      const brokenTs = path.join(tmpDir, 'widget.ts');
      const writeHandler = await writeModule.createHandler();
      const writeRes = await writeHandler.execute(
        { file_path: brokenTs, content: 'export function run() {\n  const a = 1;\n' },
        makeCtx(tmpDir),
        allowAll,
      );
      expect(writeRes.ok).toBe(true);
      if (!writeRes.ok) return;
      expect(writeRes.output).toContain('edit_file');
      expect(writeRes.output).toContain('重新生成完整文件');

      const writeCall: ToolCall = {
        id: 'scene-2a-write',
        name: 'Write',
        arguments: { file_path: brokenTs, content: 'export function run() {\n  const a = 1;\n' },
        result: {
          toolCallId: 'scene-2a-write',
          success: true,
          output: writeRes.output,
          metadata: writeRes.meta,
        },
      };

      const writeZhMarkup = renderToStaticMarkup(<ToolDetails toolCall={writeCall} />);
      expect(writeZhMarkup).toContain('检测到文件可能没写完整。如果内容有缺，告诉 Neo「继续补全」即可。');
      expect(writeZhMarkup).not.toContain('Created file:');
      assertNoForbiddenStrings(writeZhMarkup);

      // 2b. Real Edit result with broken JSON
      const brokenJson = path.join(tmpDir, 'package.json');
      await fs.writeFile(brokenJson, '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n', 'utf-8');
      await fileReadTracker.recordReadWithStats(brokenJson);

      const editHandler = await editModule.createHandler();
      const editRes = await editHandler.execute(
        {
          file_path: brokenJson,
          edits: [{ old_text: '"name": "demo",', new_text: '"name": "demo"' }],
        },
        makeCtx(tmpDir),
        allowAll,
      );
      expect(editRes.ok).toBe(true);
      if (!editRes.ok) return;
      expect(editRes.output).toContain('重新生成完整文件');

      const editCall: ToolCall = {
        id: 'scene-2b-edit',
        name: 'Edit',
        arguments: { file_path: brokenJson },
        result: {
          toolCallId: 'scene-2b-edit',
          success: true,
          output: editRes.output,
          metadata: editRes.meta,
        },
      };

      const editZhMarkup = renderToStaticMarkup(<ToolDetails toolCall={editCall} />);
      expect(editZhMarkup).toContain('检测到文件可能没写完整。如果内容有缺，告诉 Neo「继续补全」即可。');
      assertNoForbiddenStrings(editZhMarkup);

      i18nState.lang = 'en';
      const writeEnMarkup = renderToStaticMarkup(<ToolDetails toolCall={writeCall} />);
      expect(writeEnMarkup).toContain('This file may be incomplete. If anything is missing, tell Neo to');
      expect(writeEnMarkup).toContain('continue and complete it');
      expect(writeEnMarkup).not.toMatch(/[\u4e00-\u9fff]/);
      assertNoForbiddenStrings(writeEnMarkup);

      const editEnMarkup = renderToStaticMarkup(<ToolDetails toolCall={editCall} />);
      expect(editEnMarkup).toContain('This file may be incomplete. If anything is missing, tell Neo to');
      expect(editEnMarkup).toContain('continue and complete it');
      expect(editEnMarkup).not.toMatch(/[\u4e00-\u9fff]/);
      assertNoForbiddenStrings(editEnMarkup);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('Scene 3: ToolExecutionEngine validateToolArgs failure shows humanized tool step copy without schema or Minimal valid call', async () => {
    const ctx: RuntimeContext = {
      systemPrompt: '',
      modelConfig: { provider: 'openai', model: 'gpt-test' } as never,
      toolExecutor: { execute: vi.fn() } as never,
      messages: [],
      onEvent: vi.fn(),
      modelRouter: {} as never,
      maxIterations: 10,
      workingDirectory: '/tmp/code-agent-test',
      isDefaultWorkingDirectory: false,
      sessionId: 'session-scene3',
      persistLongTermMemory: true,
      includeRecentConversations: true,
      circuitBreaker: {
        recordFailure: vi.fn().mockReturnValue(false),
        recordSuccess: vi.fn(),
        generateWarningMessage: vi.fn(),
        generateUserErrorMessage: vi.fn(),
      } as never,
      antiPatternDetector: {
        trackToolFailure: vi.fn(),
        clearToolFailure: vi.fn(),
        trackDuplicateCall: vi.fn(),
        trackFileReread: vi.fn(),
        trackToolExecution: vi.fn(),
        trackReadOnlyShellCommand: vi.fn(),
        isReadOnlyShellCommand: vi.fn().mockReturnValue(false),
        preflightReadOnlyToolExecution: vi.fn().mockReturnValue(null),
        preflightReadOnlyShellCommand: vi.fn().mockReturnValue(null),
        generateHardLimitError: vi.fn(),
      } as never,
      goalTracker: { recordAction: vi.fn() } as never,
      nudgeManager: {
        trackModifiedFile: vi.fn(),
        checkProgressState: vi.fn(),
        checkPostForceExecute: vi.fn(),
      } as never,
      hookMessageBuffer: {} as never,
      messageHistoryCompressor: {} as never,
      autoCompressor: {} as never,
      compressionPipeline: {} as never,
      telemetryAdapter: {
        onTurnStart: vi.fn(),
        onModelCall: vi.fn(),
        onToolCallStart: vi.fn(),
        onToolCallEnd: vi.fn(),
        onTurnEnd: vi.fn(),
      },
      turnTrace: {
        setTurn: vi.fn(),
        record: vi.fn(),
        flush: vi.fn(),
        getEvents: vi.fn().mockReturnValue([]),
      } as never,
      turn: TurnState.forTest({
        currentIterationSpanId: 'iteration-1',
        currentTurnId: 'turn-1',
        turnStartTime: Date.now(),
        effortLevel: 'medium' as never,
      }),
      autoApprovePlan: false,
      enableHooks: true,
      maxStopHookRetries: 0,
      maxToolCallRetries: 0,
      enableToolDeferredLoading: false,
      maxMode: false,
      maxModeCandidates: 1,
      maxStructuredOutputRetries: 0,
      stepByStepMode: false,
      turnQualityState: {},
      goalEvidenceState: { bounces: 0 },
      control: ControlState.forTest(),
      budgetScope: 'foreground',
      consecutiveErrors: 0,
      stats: RunStatsState.forTest({
        traceId: 'trace-1',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        runStartTime: Date.now(),
        totalTokensUsed: 0,
        totalToolCallCount: 0,
      } as never),
      MAX_CONSECUTIVE_TRUNCATIONS: 3,
      MAX_CONSECUTIVE_COMPACTS: 3,
      contextHealth: ContextHealthState.forTest({ persistentSystemContext: [] } as never),
      artifact: ArtifactState.forTest(),
      enableDeliveryCritic: false,
    };

    const engine = new ToolExecutionEngine(ctx);
    engine.setModules(
      {
        injectSystemMessage: vi.fn(),
        pushPersistentSystemContext: vi.fn(),
        getCurrentAttachments: vi.fn().mockReturnValue([]),
      } as never,
      { emitTaskProgress: vi.fn() } as never,
      { setPlanMode: vi.fn(), isPlanMode: vi.fn().mockReturnValue(false), generateAutoContinuationPrompt: vi.fn() } as never,
    );

    const [engineResult] = await engine.executeToolsWithHooks([
      { id: 'scene-3-write-invalid', name: 'Write', arguments: {} } as ToolCall,
    ]);
    expect(engineResult.success).toBe(false);
    expect(engineResult.error).toContain('Minimal valid call:');
    expect(engineResult.error).toContain('完整参数 schema');

    const call: ToolCall = {
      id: 'scene-3-write-invalid',
      name: 'Write',
      arguments: {},
      result: engineResult,
    };

    const zhMarkup = renderToStaticMarkup(<ToolDetails toolCall={call} />);
    expect(zhMarkup).toContain('写入了一个文件的调用缺少必要信息，没有执行');
    assertNoForbiddenStrings(zhMarkup);

    const zhSummary = humanizeToolFailureReason(call, zh);
    expect(zhSummary).toBe('写入了一个文件的调用缺少必要信息，没有执行');
    assertNoForbiddenStrings(zhSummary ?? '');

    i18nState.lang = 'en';
    const enMarkup = renderToStaticMarkup(<ToolDetails toolCall={call} />);
    expect(enMarkup).toContain('This action was missing required information and did not run');
    expect(enMarkup).not.toMatch(/[\u4e00-\u9fff]/);
    assertNoForbiddenStrings(enMarkup);
  });

  it('Scene 4: foreign slot data dir deny shows plain-language isolation copy without MemoryRead / memory_search / ToolSearch / 槽', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'scene4-home-'));
    try {
      const prodMemoryFile = path.join(tmpHome, '.code-agent', 'memory', 'USER.md');
      const devSlotDir = path.join(tmpHome, '.code-agent-dev');
      await fs.mkdir(path.dirname(prodMemoryFile), { recursive: true });
      await fs.mkdir(devSlotDir, { recursive: true });
      await fs.writeFile(prodMemoryFile, '# User profile\n', 'utf-8');

      process.env.HOME = tmpHome;
      process.env.USERPROFILE = tmpHome;
      process.env.CODE_AGENT_DATA_DIR = devSlotDir;

      const executor = new ToolExecutor({
        requestPermission: async () => true,
        workingDirectory: tmpHome,
      });
      const hostResult = await executor.execute(
        'Read',
        { file_path: prodMemoryFile },
        { sessionId: 'scene-4-session' },
      );

      expect(hostResult.success).toBe(false);
      // Model-facing error still contains internal tool names & 槽
      expect(hostResult.error).toContain('MemoryRead');
      expect(hostResult.error).toContain('memory_search');
      expect(hostResult.error).toContain('ToolSearch');
      expect(hostResult.error).toContain('槽');

      const call: ToolCall = {
        id: 'scene-4-foreign-slot',
        name: 'Read',
        arguments: { file_path: prodMemoryFile },
        result: {
          toolCallId: 'scene-4-foreign-slot',
          ...hostResult,
        },
      };

      const zhPresentation = humanizeToolError(hostResult.error, 'Read', zh, hostResult.metadata);
      expect(zhPresentation?.summary).toBe('这是 Neo 另一份独立数据目录，当前不能直接读取');
      expect(zhPresentation?.detail).toBe('需要的话，直接告诉 Neo 你想找什么。');

      const zhMarkup = renderToStaticMarkup(<ToolDetails toolCall={call} />);
      expect(zhMarkup).toContain('这是 Neo 另一份独立数据目录，当前不能直接读取');
      expect(zhMarkup).toContain('需要的话，直接告诉 Neo 你想找什么。');
      assertNoForbiddenStrings(zhMarkup);

      i18nState.lang = 'en';
      const enMarkup = renderToStaticMarkup(<ToolDetails toolCall={call} />);
      expect(enMarkup).toContain('This belongs to a separate Neo data directory and cannot be read from here');
      expect(enMarkup).toContain('If you need something from it, just tell Neo what you are looking for.');
      expect(enMarkup).not.toMatch(/[\u4e00-\u9fff]/);
      assertNoForbiddenStrings(enMarkup);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });
});
