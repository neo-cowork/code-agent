// ============================================================================
// N-FIX-ATTACHMENT-NOT-IN-WORKDIR-FU1：用户提到附件但未上传时，在 sendMessage /
// interruptAndContinue 公开入口追加一行条件 turnSystemContext，并记录日志。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentAppServiceImpl } from '../../../src/host/app/agentAppService';
import { getSessionManager } from '../../../src/host/services';

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/infra/logger')>();
  return {
    ...actual,
    createLogger: () => loggerSpies,
  };
});

vi.mock('../../../src/host/observability/posthogNode', () => ({ trackNode: vi.fn() }));
vi.mock('../../../src/host/services', () => ({ getSessionManager: vi.fn() }));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: vi.fn(() => ({
    getMessageById: vi.fn(),
    getSessionForkLineage: vi.fn(() => null),
    getSessionForkContextSource: vi.fn(() => null),
    getSessionForkWorkspaceScope: vi.fn(() => null),
  })),
}));
vi.mock('../../../src/host/session/streamSnapshot', () => ({ loadStreamSnapshot: vi.fn() }));
vi.mock('../../../src/host/services/checkpoint', () => ({ getFileCheckpointService: vi.fn() }));
vi.mock('../../../src/host/services/commands/promptCommandService', () => ({
  applyPromptCommandExpansion: vi.fn(async (envelope: unknown) => envelope),
}));

describe('agentAppService missing-attachment turn context', () => {
  let tmpDir: string;
  let taskManager: {
    getOrCreateCurrentOrchestrator: ReturnType<typeof vi.fn>;
    emitAgentEventForSession: ReturnType<typeof vi.fn>;
    startTask: ReturnType<typeof vi.fn>;
    interruptAndContinue: ReturnType<typeof vi.fn>;
    cleanup: ReturnType<typeof vi.fn>;
    setCurrentSessionId: ReturnType<typeof vi.fn>;
    setSessionContext: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-attachment-turn-'));
    taskManager = {
      getOrCreateCurrentOrchestrator: vi.fn(() => ({
        setWorkingDirectory: vi.fn(),
        getWorkingDirectory: vi.fn(() => tmpDir),
      })),
      emitAgentEventForSession: vi.fn(),
      startTask: vi.fn(async () => undefined),
      interruptAndContinue: vi.fn(async () => ({ status: 'steered' })),
      cleanup: vi.fn(),
      setCurrentSessionId: vi.fn(),
      setSessionContext: vi.fn(),
    };
    vi.mocked(getSessionManager).mockReturnValue({
      getSession: vi.fn(async () => ({
        id: 'session-miss-1',
        workingDirectory: tmpDir,
        messages: [],
        messageCount: 0,
        turnCount: 0,
      })),
      getSessionMetadata: vi.fn(() => undefined),
      updateSession: vi.fn(),
    } as never);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createService(): AgentAppServiceImpl {
    return new AgentAppServiceImpl(
      () => taskManager as never,
      () => null,
      () => 'session-miss-1',
      vi.fn(),
    );
  }

  function baselineTurnContextCount(runOptions: { turnSystemContext?: string[] } | undefined): number {
    return (runOptions?.turnSystemContext ?? []).filter(
      (line) => !line.startsWith('<session_command_center>'),
    ).length;
  }

  it('adds exactly one missing-attachment turnSystemContext line and logs when attachments are empty and user says "分析这张销售表"', async () => {
    await createService().sendMessage({
      sessionId: 'session-miss-1',
      content: '分析这张销售表',
      attachments: [],
    });

    const runOptions = taskManager.startTask.mock.calls[0]?.[3] as { turnSystemContext?: string[] } | undefined;
    const nonBrainLines = (runOptions?.turnSystemContext ?? []).filter(
      (line) => !line.startsWith('<session_command_center>'),
    );
    expect(nonBrainLines).toHaveLength(1);
    expect(nonBrainLines[0]).toContain('本轮未收到任何上传附件');
    expect(nonBrainLines[0]).toContain('~/Downloads');

    expect(loggerSpies.info).toHaveBeenCalledWith(
      'Missing attachment mention detected on turn start',
      expect.objectContaining({
        sessionId: 'session-miss-1',
        keyword: '这张销售表',
        attachments: 0,
        taskFolderEmpty: true,
      }),
    );
  });

  it('adds no missing-attachment line when an attachment is uploaded', async () => {
    await createService().sendMessage({
      sessionId: 'session-miss-1',
      content: '分析这张销售表',
      attachments: [
        {
          id: 'att-1',
          type: 'file',
          category: 'data',
          name: 'sales.csv',
          size: 12,
          mimeType: 'text/csv',
          data: 'a,b\n1,2',
        },
      ],
    });

    const runOptions = taskManager.startTask.mock.calls[0]?.[3] as { turnSystemContext?: string[] } | undefined;
    expect(baselineTurnContextCount(runOptions)).toBe(0);
    expect(loggerSpies.info).not.toHaveBeenCalledWith(
      'Missing attachment mention detected on turn start',
      expect.anything(),
    );
  });

  it('adds no missing-attachment line for a plain poem request', async () => {
    await createService().sendMessage({
      sessionId: 'session-miss-1',
      content: '写一首关于春天的短诗',
      attachments: [],
    });

    const runOptions = taskManager.startTask.mock.calls[0]?.[3] as { turnSystemContext?: string[] } | undefined;
    expect(baselineTurnContextCount(runOptions)).toBe(0);
    expect(loggerSpies.info).not.toHaveBeenCalledWith(
      'Missing attachment mention detected on turn start',
      expect.anything(),
    );
  });

  it('adds no missing-attachment line when the prompt contains an explicit existing absolute path', async () => {
    const existingCsv = path.join(tmpDir, 'sales.csv');
    fs.writeFileSync(existingCsv, 'region,amount\neast,100\n', 'utf8');

    await createService().sendMessage({
      sessionId: 'session-miss-1',
      content: `分析这张销售表 ${existingCsv}`,
      attachments: [],
    });

    const runOptions = taskManager.startTask.mock.calls[0]?.[3] as { turnSystemContext?: string[] } | undefined;
    expect(baselineTurnContextCount(runOptions)).toBe(0);
    expect(loggerSpies.info).not.toHaveBeenCalledWith(
      'Missing attachment mention detected on turn start',
      expect.anything(),
    );
  });

  it('adds no missing-attachment line when the prompt names an existing file with extension in the working directory', async () => {
    const existingFile = path.join(tmpDir, 'report.xlsx');
    fs.writeFileSync(existingFile, 'dummy', 'utf8');

    await createService().sendMessage({
      sessionId: 'session-miss-1',
      content: '看看我上传的附件 report.xlsx',
      attachments: [],
    });

    const runOptions = taskManager.startTask.mock.calls[0]?.[3] as { turnSystemContext?: string[] } | undefined;
    expect(baselineTurnContextCount(runOptions)).toBe(0);
  });

  it('skips injection when the session already has earlier turns or attachments in history', async () => {
    vi.mocked(getSessionManager).mockReturnValue({
      getSession: vi.fn(async () => ({
        id: 'session-miss-1',
        workingDirectory: tmpDir,
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: '这是之前的销售表',
            timestamp: 1,
            attachments: [{ id: 'a1', type: 'file', category: 'data', name: 'sales.csv', size: 10, mimeType: 'text/csv' }],
          },
        ],
        messageCount: 1,
        turnCount: 1,
      })),
      getSessionMetadata: vi.fn(() => undefined),
      updateSession: vi.fn(),
    } as never);

    await createService().sendMessage({
      sessionId: 'session-miss-1',
      content: '分析这张销售表',
      attachments: [],
    });

    const runOptions = taskManager.startTask.mock.calls[0]?.[3] as { turnSystemContext?: string[] } | undefined;
    expect(baselineTurnContextCount(runOptions)).toBe(0);
  });
});
