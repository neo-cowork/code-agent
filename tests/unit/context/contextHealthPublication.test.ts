import { beforeEach, describe, expect, it, vi } from 'vitest';

const contextHealth = vi.hoisted(() => ({
  update: vi.fn(() => ({ compression: undefined })),
}));

vi.mock('../../../src/host/context/contextHealthService', () => ({
  getContextHealthService: () => contextHealth,
}));

vi.mock('../../../src/host/services/skills/sessionSkillService', () => ({
  getSessionSkillService: () => ({ getMountedSkillTokens: vi.fn(() => ({})) }),
}));

vi.mock('../../../src/host/tools/dispatch/toolDefinitions', () => ({
  getCoreToolDefinitions: vi.fn(() => []),
  getLoadedDeferredToolDefinitions: vi.fn(() => []),
}));

import { updateContextHealth } from '../../../src/host/agent/runtime/contextAssembly/compression';

function runtime(publishContextHealth: boolean) {
  return {
    sessionId: 'session-1',
    modelConfig: { model: 'test-model', provider: 'test-provider' },
    messages: [],
    systemPrompt: '',
    publishContextHealth,
    contextHealth: { droppedPromptBlocks: undefined, lastTurnProviderUsage: undefined },
    autoCompressor: { getStats: vi.fn(() => ({ compressionCount: 0 })) },
  };
}

describe('context health publication scope', () => {
  beforeEach(() => {
    contextHealth.update.mockClear();
  });

  it('does not let auxiliary runs publish into the session ring', () => {
    updateContextHealth({ runtime: runtime(false) } as never);

    expect(contextHealth.update).not.toHaveBeenCalled();
  });

  it('publishes health for the primary run', () => {
    updateContextHealth({ runtime: runtime(true) } as never);

    expect(contextHealth.update).toHaveBeenCalledTimes(1);
  });
});
