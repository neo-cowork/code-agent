import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_PROJECT_UNAVAILABLE } from '../../../src/shared/contract/project';
import { executeCreateSession, type SessionCreateDeps } from '../../../src/renderer/stores/sessionCreate';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { DRAFT_SCOPE_KEY } from '../../../src/renderer/stores/composerScopeModel';
import { useToastStore } from '../../../src/renderer/hooks/useToast';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

const mockDomainInvoke = vi.fn();

function makeRawSession(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
    ...overrides,
  };
}

function buildHarness(): SessionCreateDeps {
  const state = {
    sessions: [makeRawSession('existing-1') as SessionWithMeta],
    currentSessionId: 'existing-1',
    messages: [],
    todos: [],
    sessionTasks: [] as never[],
    switchSession: vi.fn(async () => {}),
    updateSessionEngine: vi.fn(async () => {}),
  };
  return {
    get: () => state,
    set: () => {},
    invalidatePendingSessionSwitches: () => {},
    findReusableNewSessionDraft: () => null,
  };
}

function createCallPayload(): Record<string, unknown> {
  const call = mockDomainInvoke.mock.calls.find(([, action]) => action === 'create');
  return (call?.[2] ?? {}) as Record<string, unknown>;
}

describe('executeCreateSession explicit projectId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToastStore.setState({ toasts: [] });
    mockDomainInvoke.mockImplementation(async (_domain: string, action: string) => ({
      success: true,
      data: action === 'create' ? makeRawSession('created') : null,
    }));
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
    };
    useComposerStore.getState().activateScope(DRAFT_SCOPE_KEY);
    useComposerStore.getState().setDraftMemoryOff(false);
  });

  it('sends the trimmed project id on the create payload', async () => {
    await executeCreateSession(buildHarness(), '整理周报', { projectId: ' proj_space ' });
    expect(createCallPayload()).toMatchObject({ projectId: 'proj_space' });
  });

  it('toasts the localized unavailable copy when the space cannot be used', async () => {
    mockDomainInvoke.mockImplementation(async () => ({
      success: false,
      error: { message: SESSION_PROJECT_UNAVAILABLE },
    }));

    const created = await executeCreateSession(buildHarness(), '整理周报', { projectId: 'proj_gone' });

    expect(created).toBeNull();
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
      '新建会话失败：这个协作空间已归档或已删除，不能在里面新建会话。',
    );
  });
});
