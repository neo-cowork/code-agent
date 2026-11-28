import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../../../src/shared/constants';
import type { Message } from '../../../src/shared/contract';
import type { DatabaseService } from '../../../src/host/services/core/databaseService';
import { setDbAvailable } from '../../../src/web/helpers/sessionCache';
import {
  createWebSessionStore,
  inMemorySessionsProjection as inMemorySessions,
  sessionMessagesProjection as sessionMessages,
} from '../../../src/web/helpers/webSessionStore';

const projectLookupSpies = vi.hoisted(() => ({
  getProjectForWorkspace: vi.fn<(workspacePath: string) => { id: string } | undefined>(() => undefined),
  findProjectForWorkspace: vi.fn<(workspacePath: string) => { id: string } | undefined>(() => undefined),
}));

vi.mock('../../../src/host/services/project/projectService', () => ({
  getProjectService: () => projectLookupSpies,
}));

const WORKSPACE_DIR = path.resolve('/workspace/demo-project');
const MODEL_CONFIG = { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };

function createDatabaseStub() {
  return {
    getSession: vi.fn<(sessionId: string) => { id: string; title: string } | null>(() => null),
    createSessionWithId: vi.fn(),
    updateSession: vi.fn(),
    addMessage: vi.fn(),
    updateMessage: vi.fn(),
    getMessages: vi.fn<() => Message[]>(() => []),
  };
}

function createLoggerStub() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('WebSessionStore direct-DB fallback project lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectLookupSpies.getProjectForWorkspace.mockReset();
    projectLookupSpies.getProjectForWorkspace.mockReturnValue(undefined);
    projectLookupSpies.findProjectForWorkspace.mockReset();
    projectLookupSpies.findProjectForWorkspace.mockReturnValue(undefined);
    sessionMessages.clear();
    inMemorySessions.clear();
    setDbAvailable(true);
  });

  afterEach(() => {
    sessionMessages.clear();
    inMemorySessions.clear();
    setDbAvailable(false, new Error('test reset'));
  });

  it('skips project lookup and "created without project_id" logs across consecutive turns when the session row already exists', async () => {
    const db = createDatabaseStub();
    db.getSession.mockReturnValue({ id: 'session-existing', title: 'Existing session' });
    const getDatabase = vi.fn(async () => db as unknown as DatabaseService);
    const logger = createLoggerStub();
    const store = createWebSessionStore({
      tryGetSessionManager: async () => null,
      logger,
      getDatabase,
    });

    const firstPersisted = await store.prePersistUserMessage({
      sessionId: 'session-existing',
      title: 'Existing session',
      modelConfig: MODEL_CONFIG,
      workingDirectory: WORKSPACE_DIR,
      message: {
        id: 'msg-turn-1',
        role: 'user',
        content: 'first turn',
        timestamp: 1,
      },
    });
    const secondPersisted = await store.prePersistUserMessage({
      sessionId: 'session-existing',
      title: 'Existing session',
      modelConfig: MODEL_CONFIG,
      workingDirectory: WORKSPACE_DIR,
      message: {
        id: 'msg-turn-2',
        role: 'user',
        content: 'second turn',
        timestamp: 2,
      },
    });

    expect(firstPersisted).toBe(true);
    expect(secondPersisted).toBe(true);
    expect(getDatabase).toHaveBeenCalledTimes(2);
    expect(projectLookupSpies.getProjectForWorkspace).not.toHaveBeenCalled();
    expect(projectLookupSpies.findProjectForWorkspace).not.toHaveBeenCalled();
    expect(db.createSessionWithId).not.toHaveBeenCalled();
    expect(db.addMessage).toHaveBeenCalledTimes(2);

    const logLines = [
      ...logger.info.mock.calls.map((args) => args.map(String).join(' ')),
      ...logger.warn.mock.calls.map((args) => args.map(String).join(' ')),
    ];
    expect(logLines.some((line) => line.includes('created without project_id'))).toBe(false);
  });

  it('resolves projectId once and passes it to createSessionWithId when the session row does not exist and the project is registered', async () => {
    const db = createDatabaseStub();
    projectLookupSpies.getProjectForWorkspace.mockReturnValue({ id: 'proj-registered-1' });
    const getDatabase = vi.fn(async () => db as unknown as DatabaseService);
    const logger = createLoggerStub();
    const store = createWebSessionStore({
      tryGetSessionManager: async () => null,
      logger,
      getDatabase,
    });

    const persisted = await store.prePersistUserMessage({
      sessionId: 'session-new-registered',
      title: 'New registered session',
      modelConfig: MODEL_CONFIG,
      workingDirectory: WORKSPACE_DIR,
      message: {
        id: 'msg-new-1',
        role: 'user',
        content: 'hello project',
        timestamp: 10,
      },
    });

    expect(persisted).toBe(true);
    expect(getDatabase).toHaveBeenCalledTimes(1);
    expect(projectLookupSpies.getProjectForWorkspace).toHaveBeenCalledTimes(1);
    expect(projectLookupSpies.getProjectForWorkspace).toHaveBeenCalledWith(WORKSPACE_DIR);
    expect(projectLookupSpies.findProjectForWorkspace).not.toHaveBeenCalled();
    expect(db.createSessionWithId).toHaveBeenCalledTimes(1);
    expect(db.createSessionWithId).toHaveBeenCalledWith('session-new-registered', {
      title: 'New registered session',
      modelConfig: MODEL_CONFIG,
      workingDirectory: WORKSPACE_DIR,
      projectId: 'proj-registered-1',
    });
  });

  it('logs no-registered-project info when the session row does not exist and the workspace has no registered project', async () => {
    const db = createDatabaseStub();
    const getDatabase = vi.fn(async () => db as unknown as DatabaseService);
    const logger = createLoggerStub();
    const store = createWebSessionStore({
      tryGetSessionManager: async () => null,
      logger,
      getDatabase,
    });

    const persisted = await store.prePersistUserMessage({
      sessionId: 'session-new-unregistered',
      title: 'Unregistered project session',
      modelConfig: MODEL_CONFIG,
      workingDirectory: WORKSPACE_DIR,
      message: {
        id: 'msg-new-2',
        role: 'user',
        content: 'hello unregistered',
        timestamp: 20,
      },
    });

    expect(persisted).toBe(true);
    expect(getDatabase).toHaveBeenCalledTimes(1);
    expect(projectLookupSpies.getProjectForWorkspace).toHaveBeenCalledTimes(1);
    expect(projectLookupSpies.findProjectForWorkspace).toHaveBeenCalledTimes(1);
    expect(db.createSessionWithId).toHaveBeenCalledTimes(1);
    expect(db.createSessionWithId).toHaveBeenCalledWith('session-new-unregistered', {
      title: 'Unregistered project session',
      modelConfig: MODEL_CONFIG,
      workingDirectory: WORKSPACE_DIR,
    });
    expect(logger.info).toHaveBeenCalledWith(
      `[AgentRouter] session session-new-unregistered created without project_id: no-registered-project (${WORKSPACE_DIR})`,
    );
  });
});
