import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { AgentAppServiceImpl } from '../../../src/host/app/agentAppService';

const fixture = vi.hoisted(() => ({ messages: [] as Message[] }));
vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => ({
    getSession: async () => ({ id: 'cap-session', workingDirectory: '/tmp' }),
    getMessages: async () => fixture.messages,
    updateSession: async () => undefined,
  }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getSessionForkWorkspaceScope: () => null }),
}));
vi.mock('../../../src/host/services/roleAssets/rolePackInstallService', () => ({
  consumeFirstRunStrict: async () => false,
}));

beforeEach(() => { fixture.messages = []; });

describe('desktop foreground cap history wiring', () => {
  it.each(['sendMessage', 'interruptAndContinue'] as const)('%s reads the last visible persisted assistant', async method => {
    const startTask = vi.fn();
    const interruptAndContinue = vi.fn();
    const manager = {
      startTask, interruptAndContinue,
      getOrCreateCurrentOrchestrator: () => ({
        getWorkingDirectory: () => '/tmp', setWorkingDirectory: vi.fn(),
      }),
    };
    const service = new AgentAppServiceImpl(() => manager as never, () => null, () => 'cap-session', vi.fn());
    for (const stopped of [false, true]) {
      fixture.messages = [
        { id: 'old-stop', role: 'assistant', content: 'old', timestamp: 1,
          metadata: { stoppedByStepLimit: true } },
        { id: 'latest', role: 'assistant', content: 'latest', timestamp: 2,
          ...(stopped ? { metadata: { stoppedByStepLimit: true } } : {}) },
        { id: 'meta', role: 'assistant', content: 'wake', timestamp: 3, isMeta: true,
          metadata: { stoppedByStepLimit: !stopped } },
        { id: 'rewound', role: 'assistant', content: 'rewound', timestamp: 4, visibility: 'rewound',
          metadata: { stoppedByStepLimit: !stopped } },
        { id: 'user', role: 'user', content: 'follow-up', timestamp: 5 },
      ];
      await service[method]({ sessionId: 'cap-session', content: '继续' });
      const call = (method === 'sendMessage' ? startTask : interruptAndContinue).mock.calls.at(-1)!;
      expect(call[3].maxIterations).toBe(stopped ? 30 : 8);
    }
  });
});
