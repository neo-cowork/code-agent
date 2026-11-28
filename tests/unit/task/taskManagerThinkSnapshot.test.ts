import { expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/shared/contract';
import { MessageDeltaAccumulator } from '../../../src/host/protocol/messageDeltaAccumulator';
import { persistTaskManagerEvent } from '../../../src/host/task/taskManagerEventPersistence';

const sessionManager = vi.hoisted(() => ({
  addMessageToSession: vi.fn(),
  updateMessage: vi.fn(),
}));
vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => sessionManager,
  notificationService: {},
}));

it('persists an empty sanitized snapshot without falling back to raw assistant deltas', async () => {
  const accumulator = new MessageDeltaAccumulator();
  const deps = {
    turnStateBySession: new Map(),
    backgroundPermissionOwners: new Map(),
    backgroundRunTerminalErrors: new Map(),
    messageDeltaAccumulator: accumulator,
  };
  const deliver = (event: AgentEvent) => persistTaskManagerEvent(
    deps, 'session-1', event, accumulator.apply('session-1', event),
  );
  await deliver({
    type: 'message_delta',
    data: { role: 'assistant', path: 'content', op: 'append', text: 'Spilled reasoning</think>' },
  });
  await deliver({
    type: 'message',
    data: { id: 'message-1', role: 'assistant', content: '', timestamp: 1 },
  });

  expect(sessionManager.addMessageToSession).toHaveBeenCalledExactlyOnceWith(
    'session-1', expect.objectContaining({ content: '', reasoning: 'Spilled reasoning' }),
  );
});
