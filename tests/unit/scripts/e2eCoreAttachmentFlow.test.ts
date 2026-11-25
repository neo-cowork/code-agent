import { describe, expect, it, vi } from 'vitest';

const { openFolderSessionMock, sendMessageMock } = vi.hoisted(() => ({
  openFolderSessionMock: vi.fn(async () => 'session-f10'),
  sendMessageMock: vi.fn(async () => undefined),
}));

vi.mock('../../../scripts/e2e-core/ui', () => ({
  approveCard: vi.fn(async () => undefined),
  driveTurn: vi.fn(async () => undefined),
  openFolderSession: openFolderSessionMock,
  sendMessage: sendMessageMock,
  settleBackground: vi.fn(async () => undefined),
  sleep: vi.fn(async () => undefined),
}));

import { f10 } from '../../../scripts/e2e-core/attachmentFlow';
import type { StepEnv } from '../../../scripts/e2e-core/types';

function createStepEnv(
  messages: Array<{ session_id: string; role: string; content: string }>,
  toolEvents: Array<{ session_id: string; tool_name: string; phase: string; status: string }> = [],
): StepEnv {
  return {
    page: {} as StepEnv['page'],
    server: {} as StepEnv['server'],
    sessionIds: ['session-f10'],
    scratch: {},
    note: vi.fn(),
    readDb: vi.fn(async () => ({
      path: 'db-1.json',
      data: {
        sessions: [{ id: 'session-f10' }],
        messages,
        toolEvents,
        permissionDecisions: [],
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
