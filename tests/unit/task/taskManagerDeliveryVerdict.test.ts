import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostReasonCode } from '../../../src/shared/contract/permission';
import type { Message } from '../../../src/shared/contract';
import type { TaskManagerEvent } from '../../../src/host/task/taskManagerTypes';

const sessionManagerState = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const configState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: configState.language } }) }),
}));

const orchestratorState = vi.hoisted(() => ({
  messageRuns: [] as Message[][],
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/agent/agentOrchestrator', () => ({
  AgentOrchestrator: class {
    private readonly messages = orchestratorState.messageRuns.shift() ?? [];
    sendMessage = vi.fn().mockResolvedValue(undefined);
    setSessionId = vi.fn();
    setMessages = vi.fn();
    setWorkingDirectory = vi.fn();
    setWorkspaceScopeAuthority = vi.fn();
    getMessages = () => this.messages;
  },
}));

vi.mock('../../../src/host/platform', () => ({
  app: { getPath: () => '/tmp' },
  AppWindow: { getAllWindows: () => [] },
  hasInteractiveUi: () => false,
}));

vi.mock('../../../src/host/task/backgroundTaskSessionContext', () => ({
  getBackgroundTaskSessionContext: (sessionId: string) => sessionManagerState.getSession(sessionId),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false }),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: (name: string) => {
      if (name === 'Write' || name === 'Edit') return { permissionLevel: 'write' };
      if (name === 'Bash') return { permissionLevel: 'execute' };
      if (name === 'Read' || name === 'read_xlsx') return { permissionLevel: 'read' };
      return undefined;
    },
  }),
}));

import { TaskManager } from '../../../src/host/task/TaskManager';
import { SessionCommandCenter } from '../../../src/host/services/commandCenter/sessionCommandCenter';
import { resetSessionTaskConcurrencyPoolForTest } from '../../../src/host/services/commandCenter/sessionTaskSlotLedger';
import {
  getBackgroundTaskLedger,
  resetBackgroundTaskLedgerForTest,
} from '../../../src/host/task/backgroundTaskLedger';
import { buildSessionTaskResultMessage } from '../../../src/host/services/commandCenter/sessionCommandTaskRestartRecovery';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';

type EventData = {
  taskId?: string;
  conclusion?: string;
  error?: string;
  detail?: string;
  artifacts?: Array<{ artifactId?: string; path?: string }>;
  rawDetail?: string;
  outcome?: { status: string; reason?: string };
};

function artifact(artifactId: string, path: string, role = 'deliverable') {
  return {
    artifactId,
    kind: path.endsWith('.xlsx') ? 'spreadsheet' : 'document',
    role,
    sourceTool: path.endsWith('.xlsx') ? 'read_xlsx' : 'Write',
    path,
  };
}

function messages(input: {
  calls: Array<{ id: string; name: string; success: boolean; hostCode?: string; command?: string; failedOutput?: string; workspace?: string; artifact?: ReturnType<typeof artifact> }>;
  conclusion: string;
}): Message[] {
  return [
    {
      id: 'assistant-tools',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: input.calls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.command === undefined ? {} : { command: call.command },
      })),
    },
    {
      id: 'tool-results',
      role: 'tool',
      content: '',
      timestamp: 2,
      toolResults: input.calls.map((call) => ({
        toolCallId: call.id,
        success: call.success,
        ...(call.success ? { output: 'ok' } : { error: 'save failed' }),
        ...(call.artifact ? { metadata: { artifact: call.artifact } } : {}),
        ...(call.hostCode ? { metadata: { hostReason: { code: call.hostCode } } } : {}),
        ...(call.failedOutput !== undefined ? { metadata: { code: 'COMMAND_FAILED', output: call.failedOutput, ...(call.workspace ? { writeIsolation: { kind: 'workspace', targetPath: call.workspace } } : {}) } } : {}),
      })),
    },
    { id: 'assistant-final', role: 'assistant', content: input.conclusion, timestamp: 3 },
  ];
}

async function runBackgroundTask(runMessages: Message[]): Promise<TaskManagerEvent> {
  orchestratorState.messageRuns.push(runMessages);
  const manager = new TaskManager({ maxConcurrentTasks: 1 });
  manager.initialize({ configService: {} as never, onAgentEvent: vi.fn() });
  const terminalEvents: TaskManagerEvent[] = [];
  manager.on('event', (event: TaskManagerEvent) => {
    if (event.type === 'task_completed' || event.type === 'task_error' || event.type === 'task_cancelled') terminalEvents.push(event);
  });

  await manager.startBackgroundTask('task-1', 'session-1', 'do the work');

  expect(terminalEvents).toHaveLength(1);
  return terminalEvents[0];
}

describe('TaskManager background delivery verdict', () => {
  beforeEach(() => {
    orchestratorState.messageRuns.length = 0;
    sessionManagerState.getSession.mockReset().mockResolvedValue(undefined);
    resetSessionTaskConcurrencyPoolForTest();
    resetBackgroundTaskLedgerForTest();
  });

  it('keeps a successful write completed with its artifact', async () => {
    const event = await runBackgroundTask(messages({
      calls: [{ id: 'write-1', name: 'Write', success: true, artifact: artifact('report-1', '/work/report.md') }],
      conclusion: 'Report saved.',
    }));

    expect(event.type).toBe('task_completed');
    expect(event.data as EventData).toMatchObject({
      conclusion: 'Report saved.',
      artifacts: [{ artifactId: 'report-1', path: '/work/report.md' }],
    });
  });

  it('emits task_error with the conclusion when every write failed and nothing was delivered', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'write-1', name: 'Write', success: false },
        { id: 'edit-1', name: 'Edit', success: false },
      ],
      conclusion: 'I could not save the requested report.',
    }));

    expect(event.type).toBe('task_error');
    expect(event.data as EventData).toMatchObject({
      error: 'I could not save the requested report.',
    });
  });

  it('persists the all-writes-failed event as a failed command-center row with the conclusion', async () => {
    orchestratorState.messageRuns.push(messages({
      calls: [{ id: 'write-1', name: 'Write', success: false }],
      conclusion: 'I could not save the requested report.',
    }));
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({ configService: {} as never, onAgentEvent: vi.fn() });
    const center = new SessionCommandCenter(manager, {
      projectTerminalResult: vi.fn(),
      persistMemberInput: vi.fn(),
      wakeForegroundBrain: vi.fn(),
    });

    const spawned = await center.spawn({
      sessionId: 'session-1',
      title: 'Save report',
      shortName: 'report',
      laneKey: 'report',
      submissionKey: 'report-1',
      prompt: 'save the report',
      workspaceScope: createWorkspaceScope('project-1', [{
        sourceId: 'primary',
        path: '/work',
        role: 'primary',
        access: 'read_write',
      }]),
    });
    if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');

    await vi.waitFor(() => expect(center.list('session-1')[0]).toMatchObject({
      status: 'failed',
      detail: 'I could not save the requested report.',
    }));
    expect(getBackgroundTaskLedger().listTasks({ sessionId: 'session-1' })[0]).toMatchObject({
      status: 'failed',
      summary: 'I could not save the requested report.',
      outputRefs: [],
    });
    center.dispose();
  });

  it('keeps mixed failed and successful writes completed', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'write-1', name: 'Write', success: false },
        { id: 'write-2', name: 'Write', success: true },
      ],
      conclusion: 'The retry succeeded.',
    }));

    expect(event.type).toBe('task_completed');
    expect(event.data as EventData).toMatchObject({ conclusion: 'The retry succeeded.' });
  });

  it('keeps a no-write research task completed', async () => {
    const event = await runBackgroundTask(messages({
      calls: [{ id: 'read-1', name: 'Read', success: true }],
      conclusion: 'The research answer is 42.',
    }));

    expect(event.type).toBe('task_completed');
    expect(event.data as EventData).toMatchObject({ conclusion: 'The research answer is 42.' });
  });

  it('does not expose four read_xlsx source artifacts as outputs', async () => {
    const source = artifact('sales-input', '/work/sales.xlsx', 'material');
    const event = await runBackgroundTask(messages({
      calls: Array.from({ length: 4 }, (_, index) => ({
        id: `read-xlsx-${index}`,
        name: 'read_xlsx',
        success: true,
        artifact: source,
      })),
      conclusion: 'The workbook was analyzed.',
    }));

    expect(event.type).toBe('task_completed');
    expect(event.data as EventData).not.toHaveProperty('artifacts');
  });

  it('keeps only the first artifact when writes report the same path twice', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'write-1', name: 'Write', success: true, artifact: artifact('first', '/work/report.md') },
        { id: 'write-2', name: 'Write', success: true, artifact: artifact('second', '/work/report.md') },
      ],
      conclusion: 'Report saved.',
    }));

    expect(event.type).toBe('task_completed');
    expect((event.data as EventData).artifacts).toEqual([
      expect.objectContaining({ artifactId: 'first', path: '/work/report.md' }),
    ]);
  });

  it('ends a user-denied write as task_cancelled with one plain sentence', async () => {
    const event = await runBackgroundTask(messages({
      calls: [{ id: 'write-1', name: 'Write', success: false, hostCode: HostReasonCode.PermissionDeniedByUser }],
      conclusion: '创建文件的写入操作被拒绝，因此该文件未被生成。',
    }));

    expect(event.type).toBe('task_cancelled');
    expect((event.data as EventData).detail).toBe('你拒绝了这一步，任务已停止。');
  });

  it('keeps a tool-error write failed even when the host reason is not a user denial', async () => {
    const event = await runBackgroundTask(messages({
      calls: [{ id: 'write-1', name: 'Write', success: false, hostCode: HostReasonCode.PermissionDeniedSafetyRule }],
      conclusion: 'Blocked by policy.',
    }));
    expect(event.type).toBe('task_error');
  });

  it('keeps an approval timeout failed as approval_timeout', async () => {
    const event = await runBackgroundTask(messages({
      calls: [{ id: 'write-1', name: 'Write', success: false, hostCode: HostReasonCode.PermissionDeniedTimeout }],
      conclusion: 'Timed out.',
    }));
    expect(event.type).toBe('task_error');
    expect((event.data as EventData).error).toContain('一直没有等到批准');
  });

  it('keeps a denied write completed when another write succeeded', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'write-1', name: 'Write', success: false, hostCode: HostReasonCode.PermissionDeniedByUser },
        { id: 'write-2', name: 'Write', success: true },
      ],
      conclusion: 'Saved the second file.',
    }));
    expect(event.type).toBe('task_completed');
  });

  it('ends a user-denied Bash (execute) as task_cancelled and drops the model chmod prose', async () => {
    const event = await runBackgroundTask(messages({
      calls: [{ id: 'bash-1', name: 'Bash', success: false, hostCode: HostReasonCode.PermissionDeniedByUser }],
      conclusion: 'chmod 600 notes.txt 已被用户拒绝，权限未修改。',
    }));
    expect(event.type).toBe('task_cancelled');
    expect((event.data as EventData).detail).toBe('你拒绝了这一步，任务已停止。');
    expect(JSON.stringify(event.data)).not.toContain('chmod');
  });

  it('ends a failed Bash (COMMAND_FAILED) as task_error: one plain sentence collapsed, command only in rawDetail, workspace paths as ./', async () => {
    sessionManagerState.getSession.mockResolvedValue({ messages: [], workingDirectory: '/work/proj' });
    const event = await runBackgroundTask(messages({
      calls: [{ id: 'bash-1', name: 'Bash', success: false, command: '/work/proj/check.sh', failedOutput: 'missing: brief.pdf' }],
      conclusion: '检查完成。',
    }));
    expect(event.type).toBe('task_error');
    const data = event.data as EventData;
    expect(data.error).toBe('这个后台任务没有做完：中间有一步没做成。补上缺少的内容后，可以让我再试一次。');
    expect(data.error).not.toMatch(/check\.sh|missing|exit/);
    expect(data.rawDetail).toContain('后台任务没能完成：命令 ./check.sh 没有运行成功（missing: brief.pdf），已停止。');
    expect(JSON.stringify(event.data)).not.toContain('/work/proj');
  });

  it('words the failed-command task_error in English when the UI language is en', async () => {
    configState.language = 'en';
    try {
      sessionManagerState.getSession.mockResolvedValue({ messages: [], workingDirectory: '/work/proj' });
      const event = await runBackgroundTask(messages({
        calls: [{ id: 'bash-1', name: 'Bash', success: false, command: '/work/proj/check.sh', failedOutput: 'missing: brief.pdf' }],
        conclusion: 'done',
      }));
      expect(event.type).toBe('task_error');
      expect((event.data as EventData).error).toBe('This background task is not done: one of its steps did not work. Add what is missing and I can try again.');
      expect((event.data as EventData).rawDetail).toContain('The background task could not finish: the command ./check.sh did not run successfully (missing: brief.pdf), so it stopped.');
    } finally {
      configState.language = 'zh';
    }
  });

  it('still names the failed command when only a read-only Bash probe ran afterwards', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'bash-1', name: 'Bash', success: false, command: './check.sh', failedOutput: 'missing: brief.pdf' },
        { id: 'bash-2', name: 'Bash', success: true, command: 'ls -la' },
      ],
      conclusion: '看了一下目录。',
    }));
    expect(event.type).toBe('task_error');
    expect((event.data as EventData).rawDetail).toContain('后台任务没能完成：命令 ./check.sh 没有运行成功（missing: brief.pdf），已停止。');
  });

  it('shows the workspace as ./ from the result write root when the session has no working directory', async () => {
    const event = await runBackgroundTask(messages({
      calls: [{ id: 'bash-1', name: 'Bash', success: false, command: 'cd /Users/someone/proj/ws; sh check.sh', failedOutput: 'missing: brief.pdf', workspace: '/Users/someone/proj/ws' }],
      conclusion: 'done',
    }));
    expect(event.type).toBe('task_error');
    expect((event.data as EventData).rawDetail).toContain('后台任务没能完成：命令 cd ./; sh check.sh 没有运行成功（missing: brief.pdf），已停止。');
    expect((event.data as EventData).error).not.toContain('check.sh');
  });

  it('keeps a failed Bash completed when a later non-probe Bash succeeded', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'bash-1', name: 'Bash', success: false, command: './check.sh', failedOutput: 'missing: brief.pdf' },
        { id: 'bash-2', name: 'Bash', success: true, command: 'npm test' },
      ],
      conclusion: 'Fixed and verified.',
    }));
    expect(event.type).toBe('task_completed');
  });

  it('keeps a failed Bash completed when a deliverable artifact exists', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'bash-1', name: 'Bash', success: false, command: './check.sh', failedOutput: 'x' },
        { id: 'w-1', name: 'Write', success: true, artifact: artifact('a1', '/tmp/report.xlsx') },
      ],
      conclusion: 'Report saved.',
    }));
    expect(event.type).toBe('task_completed');
  });

  it('keeps a denied Bash completed when a later Bash succeeded', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'bash-1', name: 'Bash', success: false, hostCode: HostReasonCode.PermissionDeniedByUser },
        { id: 'bash-2', name: 'Bash', success: true },
      ],
      conclusion: 'Done another way.',
    }));
    expect(event.type).toBe('task_completed');
  });

  it('cancels a denied Bash when the later success is only ls -l notes.txt', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'bash-1', name: 'Bash', success: false, hostCode: HostReasonCode.PermissionDeniedByUser, command: 'chmod 600 notes.txt' },
        { id: 'bash-2', name: 'Bash', success: true, command: 'ls -l notes.txt' },
      ],
      conclusion: '只看了权限，任务算完成。',
    }));
    expect(event.type).toBe('task_cancelled');
    expect((event.data as EventData).detail).toBe('你拒绝了这一步，任务已停止。');
    expect(JSON.stringify(event.data)).not.toContain('只看了权限');
    expect(JSON.stringify(event.data)).not.toContain('chmod');
  });

  it('keeps a denied Bash completed when a later npm test succeeded', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'bash-1', name: 'Bash', success: false, hostCode: HostReasonCode.PermissionDeniedByUser, command: 'chmod 600 notes.txt' },
        { id: 'bash-2', name: 'Bash', success: true, command: 'npm test' },
      ],
      conclusion: 'Tests passed.',
    }));
    expect(event.type).toBe('task_completed');
    expect((event.data as EventData).conclusion).toBe('Tests passed.');
  });

  it('keeps a denied Bash completed when ls -l is followed by a successful write', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'bash-1', name: 'Bash', success: false, hostCode: HostReasonCode.PermissionDeniedByUser, command: 'chmod 600 notes.txt' },
        { id: 'bash-2', name: 'Bash', success: true, command: 'ls -l' },
        { id: 'write-1', name: 'Write', success: true },
      ],
      conclusion: 'Wrote the note another way.',
    }));
    expect(event.type).toBe('task_completed');
    expect((event.data as EventData).conclusion).toBe('Wrote the note another way.');
  });

  it('keeps a denied Bash completed when a later ls and chmod compound succeeded', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'bash-1', name: 'Bash', success: false, hostCode: HostReasonCode.PermissionDeniedByUser, command: 'chmod 600 notes.txt' },
        { id: 'bash-2', name: 'Bash', success: true, command: 'ls -l a && chmod 600 a' },
      ],
      conclusion: 'Permissions updated.',
    }));
    expect(event.type).toBe('task_completed');
    expect((event.data as EventData).conclusion).toBe('Permissions updated.');
  });

  it('keeps a denied Bash completed when a deliverable artifact exists', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'bash-1', name: 'Bash', success: false, hostCode: HostReasonCode.PermissionDeniedByUser },
        { id: 'read-1', name: 'Read', success: true, artifact: artifact('report-1', '/work/report.md') },
      ],
      conclusion: 'Report delivered.',
    }));
    expect(event.type).toBe('task_completed');
  });

  it('keeps a tool-error write failed even when a later Bash succeeded', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'write-1', name: 'Write', success: false },
        { id: 'bash-1', name: 'Bash', success: true },
      ],
      conclusion: 'Checked the folder with ls.',
    }));
    expect(event.type).toBe('task_error');
  });

  it('keeps a tool-error write failed when a Bash was also declined', async () => {
    const event = await runBackgroundTask(messages({
      calls: [
        { id: 'write-1', name: 'Write', success: false },
        { id: 'bash-1', name: 'Bash', success: false, hostCode: HostReasonCode.PermissionDeniedByUser },
      ],
      conclusion: 'Could not save.',
    }));
    expect(event.type).toBe('task_error');
  });

  it('keeps a Bash failure that is not a user denial completed', async () => {
    for (const hostCode of [HostReasonCode.PermissionDeniedSafetyRule, undefined]) {
      const event = await runBackgroundTask(messages({
        calls: [{ id: 'bash-1', name: 'Bash', success: false, hostCode }],
        conclusion: 'Command exited non-zero.',
      }));
      expect(event.type).toBe('task_completed');
    }
  });

  it('keeps a Read-only research task completed', async () => {
    const event = await runBackgroundTask(messages({
      calls: [{ id: 'read-1', name: 'Read', success: true }],
      conclusion: 'Read-only findings.',
    }));
    expect(event.type).toBe('task_completed');
  });

  it('projects a user-denied background task as a cancelled [任务结果] row, zh and en', async () => {
    for (const [language, status, sentence] of [
      ['zh', '已取消', '你拒绝了这一步，任务已停止。'],
      ['en', 'cancelled', 'You declined this step, so the task was stopped.'],
    ] as const) {
      configState.language = language;
      resetSessionTaskConcurrencyPoolForTest();
      resetBackgroundTaskLedgerForTest();
      orchestratorState.messageRuns.push(messages({
        calls: [{ id: 'write-1', name: 'Bash', success: false, hostCode: HostReasonCode.PermissionDeniedByUser }],
        conclusion: 'chmod 600 notes.txt 已被用户拒绝，权限未修改。',
      }));
      const manager = new TaskManager({ maxConcurrentTasks: 1 });
      manager.initialize({ configService: {} as never, onAgentEvent: vi.fn() });
      const projectTerminalResult = vi.fn();
      const center = new SessionCommandCenter(manager, {
        projectTerminalResult,
        persistMemberInput: vi.fn(),
        wakeForegroundBrain: vi.fn(),
      });
      const spawned = await center.spawn({
        sessionId: 'session-1', title: 'Summary', shortName: 'summary', laneKey: 'summary',
        submissionKey: `summary-${language}`, prompt: 'write summary',
        workspaceScope: createWorkspaceScope('project-1', [{
          sourceId: 'primary', path: '/work', role: 'primary', access: 'read_write',
        }]),
      });
      if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');
      await vi.waitFor(() => expect(projectTerminalResult).toHaveBeenCalled());
      const [task, projectedStatus] = projectTerminalResult.mock.calls[0];
      const row = buildSessionTaskResultMessage(
        task, projectedStatus, task.resultText ?? task.summary, `session-task-result-${task.id}`, language,
      );
      const projected = JSON.stringify(row);
      expect(row.metadata?.backgroundTaskResult?.status).toBe('cancelled');
      expect(projected).toContain(status);
      expect(projected).toContain(sentence);
      expect(projected).not.toContain('chmod');
      expect(projected).not.toContain('已被用户拒绝');
      center.dispose();
    }
    configState.language = 'zh';
  });

  describe('structured helper outcome', () => {
    const MARKER = '__NEO_TASK_OUTCOME__';
    const maskedCopy = (conclusion: string) => messages({
      calls: [
        { id: 'bash-1', name: 'Bash', success: false, command: 'cp missing-report.txt archive/', failedOutput: 'cp: missing-report.txt: No such file or directory' },
        { id: 'bash-2', name: 'Bash', success: true, command: 'touch archive/.checked' },
      ],
      conclusion,
    });

    it('turns a helper-reported failed into task_error even though a later command succeeded (masked exit)', async () => {
      const event = await runBackgroundTask(maskedCopy(`${MARKER}{"status":"failed","reason":"源文件不存在"}\n复制没有做成，源文件不在。`));
      const data = event.data as EventData;
      expect(event.type).toBe('task_error');
      expect(data.outcome).toEqual({ status: 'failed', reason: '源文件不存在' });
      expect(data.error).toBe('这个后台任务没有做完：中间有一步没做成。补上缺少的内容后，可以让我再试一次。');
      expect(data.rawDetail).toContain('复制没有做成，源文件不在。');
      expect(JSON.stringify(event.data)).not.toContain(MARKER);
    });

    it('turns partial into task_error with the partial sentence, in English too', async () => {
      configState.language = 'en';
      try {
        const event = await runBackgroundTask(messages({
          calls: [{ id: 'read-1', name: 'Read', success: true }],
          conclusion: `${MARKER}{"status":"partial"}\nCopied 2 of 3 files.`,
        }));
        const data = event.data as EventData;
        expect(event.type).toBe('task_error');
        expect(data.outcome).toEqual({ status: 'partial' });
        expect(data.error).toBe('This background task is only partly done: some steps did not work. Add what is missing and I can pick it up again.');
        expect(data.rawDetail).toBe('Copied 2 of 3 files.');
      } finally {
        configState.language = 'zh';
      }
    });

    it('strips the marker from a done outcome and keeps the completed state', async () => {
      const event = await runBackgroundTask(messages({
        calls: [{ id: 'read-1', name: 'Read', success: true }],
        conclusion: `${MARKER}{"status":"done"}\nAll three files copied.`,
      }));
      expect(event.type).toBe('task_completed');
      expect(event.data).toMatchObject({ conclusion: 'All three files copied.', outcome: { status: 'done' } });
      expect(JSON.stringify(event.data)).not.toContain(MARKER);
    });

    it('strips a malformed marker without inventing an outcome and keeps the old verdict', async () => {
      const event = await runBackgroundTask(messages({
        calls: [{ id: 'read-1', name: 'Read', success: true }],
        conclusion: `${MARKER}{"status":"great"\nSummary of findings.`,
      }));
      expect(event.type).toBe('task_completed');
      expect((event.data as EventData).conclusion).toBe('Summary of findings.');
      expect((event.data as EventData).outcome).toBeUndefined();
    });

    it('does not guess from prose: no marker keeps the existing verdict even when the helper says it failed', async () => {
      const event = await runBackgroundTask(messages({
        calls: [{ id: 'read-1', name: 'Read', success: true }],
        conclusion: 'The copy did not happen because the file is missing.',
      }));
      expect(event.type).toBe('task_completed');
      expect(event.data).toEqual({ taskId: 'task-1', conclusion: 'The copy did not happen because the file is missing.' });
    });

    it('settles a masked-exit helper as failed end to end: collapsed rows plain, raw details expanded, marker nowhere', async () => {
      configState.language = 'zh';
      resetSessionTaskConcurrencyPoolForTest();
      resetBackgroundTaskLedgerForTest();
      orchestratorState.messageRuns.push(maskedCopy(`${MARKER}{"status":"failed","reason":"源文件不存在"}\n复制没有做成，源文件不在。`));
      const manager = new TaskManager({ maxConcurrentTasks: 1 });
      manager.initialize({ configService: {} as never, onAgentEvent: vi.fn() });
      const projectTerminalResult = vi.fn();
      const center = new SessionCommandCenter(manager, {
        projectTerminalResult, persistMemberInput: vi.fn(), wakeForegroundBrain: vi.fn(),
      });
      const spawned = await center.spawn({
        sessionId: 'session-1', title: 'Archive', shortName: 'archive', laneKey: 'archive',
        submissionKey: 'archive-outcome', prompt: 'copy the report',
        workspaceScope: createWorkspaceScope('project-1', [{
          sourceId: 'primary', path: '/work', role: 'primary', access: 'read_write',
        }]),
      });
      if (spawned.outcome === 'requires_choice') throw new Error('unexpected admission result');
      await vi.waitFor(() => expect(projectTerminalResult).toHaveBeenCalled());
      const [task, projectedStatus] = projectTerminalResult.mock.calls[0];
      expect(projectedStatus).toBe('failed');

      const ledgerTask = getBackgroundTaskLedger().listTasks({ sessionId: 'session-1' })[0];
      expect(ledgerTask.status).toBe('failed');
      expect(ledgerTask.failure?.outcome).toEqual({ status: 'failed', reason: '源文件不存在' });
      expect(ledgerTask.failure?.message).toBe('这个后台任务没有做完：中间有一步没做成。补上缺少的内容后，可以让我再试一次。');
      expect(ledgerTask.summary).not.toMatch(/cp |No such file|exit/);
      expect(String(ledgerTask.metadata?.resultMarkdown)).toContain('cp missing-report.txt archive/');
      expect(String(ledgerTask.metadata?.resultMarkdown)).toContain('复制没有做成，源文件不在。');

      const row = buildSessionTaskResultMessage(
        task, projectedStatus, task.resultText ?? task.summary, `session-task-result-${task.id}`, 'zh', [], task.outcome,
      );
      expect(row.metadata?.backgroundTaskResult).toMatchObject({ status: 'failed', outcome: { status: 'failed' } });
      for (const surface of [JSON.stringify(row), JSON.stringify(ledgerTask), task.stopped?.content ?? '']) {
        expect(surface).not.toContain(MARKER);
      }
      expect(task.stopped?.content).toBe('这个后台任务没有做完：中间有一步没做成。补上缺少的内容后，可以让我再试一次。');
      center.dispose();
    });
  });
});
