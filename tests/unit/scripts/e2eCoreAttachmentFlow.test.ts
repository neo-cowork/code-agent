import { describe, expect, it, vi } from 'vitest';
import type { AttemptEnv } from '../../../scripts/e2e-core/types';

const { openFolderSessionMock, sendMessageMock } = vi.hoisted(() => ({
  openFolderSessionMock: vi.fn<(env: AttemptEnv, title: string) => Promise<string>>(async () => 'session-f10'),
  sendMessageMock: vi.fn<(page: AttemptEnv['page'], text: string) => Promise<void>>(async () => undefined),
}));

vi.mock('../../../scripts/e2e-core/ui', () => ({
  approveCard: vi.fn(async () => '允许一次'),
  driveTurn: vi.fn(async () => undefined),
  openFolderSession: openFolderSessionMock,
  sendMessage: sendMessageMock,
  settleBackground: vi.fn(async () => undefined),
  sleep: vi.fn(async () => undefined),
}));

import { f10 } from '../../../scripts/e2e-core/attachmentFlow';

function createStepEnv(
  messages: Array<{ session_id: string; role: string; content: string }>,
  toolEvents: Array<{ session_id: string; tool_name: string; phase: string; status: string }> = [],
): AttemptEnv {
  return {
    page: {} as AttemptEnv['page'],
    server: {} as AttemptEnv['server'],
    sessionIds: ['session-f10'],
    startedAtMs: 0,
    sseFile: 'test.sse',
    scratch: {},
    note: vi.fn(),
    readDb: vi.fn(async () => ({
      file: 'db-1.json',
      data: {
        sessions: [{ id: 'session-f10' }],
        messages,
        toolEvents,
        pendingApprovals: [],
        permissionDecisions: [],
        cronJobs: [],
        cronExecutions: [],
      },
    })),
  };
}

describe('e2e-core F10 attachmentFlow', () => {
  it('asks for both the best region/month and the regional Q1 total in step 1', async () => {
    openFolderSessionMock.mockClear();
    sendMessageMock.mockClear();

    const env = createStepEnv([]);
    env.sessionIds = [];

    await f10.steps[0].run(env);

    expect(env.sessionIds).toEqual(['session-f10']);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const sentPrompt = String(sendMessageMock.mock.calls[0]?.[1] ?? '');
    expect(sentPrompt).toContain('q1-sales.xlsx');
    expect(sentPrompt).toContain('哪个区域哪个月卖得最好');
    expect(sentPrompt).toContain('各区域一季度的合计');
    expect(f10.steps[0].text).toContain(sentPrompt);
  });

  it('requires East March, 150,000, and quarterly total 405,000 in step 3', async () => {
    const completeEnv = createStepEnv(
      [
        {
          session_id: 'session-f10',
          role: 'assistant',
          content: '华东区 3 月卖得最好，150,000 元；华东一季度合计 405,000。',
        },
      ],
      [
        {
          session_id: 'session-f10',
          tool_name: 'ExcelAutomate',
          phase: 'complete',
          status: 'success',
        },
      ],
    );

    await expect(f10.steps[2].run(completeEnv)).resolves.toBeUndefined();

    const missingTotalEnv = createStepEnv([
      {
        session_id: 'session-f10',
        role: 'assistant',
        content: '华东区 3 月卖得最好，150,000 元。',
      },
    ]);

    await expect(f10.steps[2].run(missingTotalEnv)).rejects.toThrow(/季度小结（华东合计 405,000）/);
  });
});
