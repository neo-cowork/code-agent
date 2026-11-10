import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  database: {
    isReady: true,
    getMessages: vi.fn(),
    getSessionSearchMeta: vi.fn(),
    searchSessionTitles: vi.fn(),
  },
  auth: { userId: null as string | null },
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => mocks.database,
}));

vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => (mocks.auth.userId ? { id: mocks.auth.userId } : null) }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => mocks.logger,
  logger: mocks.logger,
}));

import { performCrossSessionSearch } from '../../../src/host/ipc/session.ipc';
import { getDefaultCache } from '../../../src/host/session/localCache';

function seedSessionMeta(rows: Array<{ sessionId: string; title: string; updatedAt?: number; archived?: boolean }>): void {
  mocks.database.getSessionSearchMeta.mockImplementation((ids: string[]) =>
    rows
      .filter((row) => ids.includes(row.sessionId))
      .map((row) => ({ updatedAt: 1, createdAt: 1, archived: false, ...row })),
  );
}

describe('cross-session search hydration', () => {
  beforeEach(() => {
    getDefaultCache().clear();
    mocks.database.isReady = true;
    mocks.database.getMessages.mockReset();
    mocks.logger.warn.mockReset();
    mocks.database.getSessionSearchMeta.mockReset().mockImplementation((ids: string[]) =>
      ids.map((sessionId) => ({ sessionId, title: `Title ${sessionId}`, updatedAt: 1, createdAt: 1, archived: false })));
    mocks.database.searchSessionTitles.mockReset().mockReturnValue([]);
    mocks.auth.userId = null;
  });

  it('finds a body-only match after hydrating the requested session from the database', async () => {
    mocks.database.getMessages.mockReturnValue([
      {
        id: 'message-body-hit',
        role: 'assistant',
        content: 'The persisted transcript contains needle-body-only here.',
        timestamp: 10,
      },
    ]);

    seedSessionMeta([{ sessionId: 'session-body-hit', title: 'A title without the search term' }]);
    const result = await performCrossSessionSearch(
      'needle-body-only',
      { sessionIds: ['session-body-hit'] },
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      sessionId: 'session-body-hit',
      sessionTitle: 'A title without the search term',
      messageId: 'message-body-hit',
    });
    expect(result.results[0].snippet).toContain('needle-body-only');
  });

  it('does not read messages again when the requested session is already cached', async () => {
    getDefaultCache().setSession({
      sessionId: 'session-cached',
      messages: [{
        id: 'cached-message',
        role: 'user',
        content: 'cached needle',
        timestamp: 20,
      }],
      startedAt: 20,
      lastActivityAt: 20,
      totalTokens: 0,
    });

    const result = await performCrossSessionSearch(
      'cached needle',
      { sessionIds: ['session-cached'] },
    );

    expect(mocks.database.getMessages).not.toHaveBeenCalled();
    expect(result.results.map((item) => item.messageId)).toEqual(['cached-message']);
  });

  it('caps each database hydration read at 500 messages', async () => {
    mocks.database.getMessages.mockReturnValue([]);

    await performCrossSessionSearch(
      'needle',
      { sessionIds: ['session-bounded'] },
    );

    expect(mocks.database.getMessages).toHaveBeenCalledTimes(1);
    expect(mocks.database.getMessages).toHaveBeenCalledWith('session-bounded', 500);
  });

  it('skips a failed session read while returning matches from other requested sessions', async () => {
    mocks.database.getMessages.mockImplementation((sessionId: string) => {
      if (sessionId === 'session-failed') {
        throw new Error('database read failed');
      }
      return [{
        id: 'message-survives',
        role: 'user',
        content: 'resilient needle remains searchable',
        timestamp: 30,
      }];
    });

    const result = await performCrossSessionSearch(
      'resilient needle',
      { sessionIds: ['session-failed', 'session-healthy'] },
    );

    expect(result.results.map((item) => item.messageId)).toEqual(['message-survives']);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Failed to hydrate session for cross-session search',
      expect.objectContaining({
        sessionId: 'session-failed',
        error: expect.any(Error),
      }),
    );
  });

  it('skips scoped hydration and logs when the database is not ready', async () => {
    mocks.database.isReady = false;

    const result = await performCrossSessionSearch(
      'needle',
      { sessionIds: ['session-db-not-ready'] },
    );

    expect(mocks.database.getMessages).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Skipping cross-session search hydration because database is not ready',
      { sessionIds: ['session-db-not-ready'] },
    );
  });

  it('does not hydrate from the database when sessionIds are omitted', async () => {
    getDefaultCache().setSession({
      sessionId: 'session-cache-only',
      messages: [{
        id: 'cache-only-message',
        role: 'assistant',
        content: 'cache-only needle',
        timestamp: 40,
      }],
      startedAt: 40,
      lastActivityAt: 40,
      totalTokens: 0,
    });

    const result = await performCrossSessionSearch(
      'cache-only needle',
      undefined,
    );

    expect(mocks.database.getMessages).not.toHaveBeenCalled();
    expect(result.results.map((item) => item.messageId)).toEqual(['cache-only-message']);
  });
  it('looks up title/updatedAt/archived per hit session from the DB (not the first listSessions page) and sends no id restriction', async () => {
    getDefaultCache().setSession({
      sessionId: 'session-58',
      messages: [{ id: 'm-58', role: 'user', content: 'zebra-quartz in an old chat', timestamp: 58 }],
      startedAt: 58,
      lastActivityAt: 58,
      totalTokens: 0,
    });
    seedSessionMeta([{ sessionId: 'session-58', title: 'zebra-quartz 旧任务', updatedAt: 1234 }]);

    const result = await performCrossSessionSearch('zebra-quartz', undefined);

    expect(mocks.database.getSessionSearchMeta).toHaveBeenCalledWith(['session-58'], null);
    expect(result.results[0]).toMatchObject({
      sessionId: 'session-58',
      sessionTitle: 'zebra-quartz 旧任务',
      sessionUpdatedAt: 1234,
      sessionArchived: false,
    });
  });

  it('flags archived sessions and drops hits whose session is not visible to the current owner', async () => {
    mocks.auth.userId = 'user-1';
    getDefaultCache().setSession({
      sessionId: 'session-arch',
      messages: [{ id: 'm-a', role: 'user', content: 'owner-needle one', timestamp: 1 }],
      startedAt: 1, lastActivityAt: 1, totalTokens: 0,
    });
    getDefaultCache().setSession({
      sessionId: 'session-foreign',
      messages: [{ id: 'm-f', role: 'user', content: 'owner-needle two', timestamp: 2 }],
      startedAt: 2, lastActivityAt: 2, totalTokens: 0,
    });
    seedSessionMeta([{ sessionId: 'session-arch', title: 'Archived', archived: true }]);

    const result = await performCrossSessionSearch('owner-needle', undefined);

    expect(mocks.database.getSessionSearchMeta).toHaveBeenCalledWith(expect.any(Array), 'user-1');
    expect(result.results.map((item) => [item.sessionId, item.sessionArchived])).toEqual([['session-arch', true]]);
  });

  it('returns title matches from the DB and logs which step failed instead of swallowing it', async () => {
    mocks.database.searchSessionTitles.mockReturnValue([
      { sessionId: 'old-title', title: 'Browser 采集 任务', updatedAt: 9, createdAt: 1, archived: false },
    ]);
    const ok = await performCrossSessionSearch('采集', undefined);
    expect(mocks.database.searchSessionTitles).toHaveBeenCalledWith('采集', null, 20);
    expect(ok.titleMatches).toEqual([{ sessionId: 'old-title', title: 'Browser 采集 任务', updatedAt: 9 }]);

    mocks.database.searchSessionTitles.mockImplementation(() => { throw new Error('title query broke'); });
    mocks.database.getSessionSearchMeta.mockImplementation(() => { throw new Error('meta query broke'); });
    const failed = await performCrossSessionSearch('采集', undefined);
    expect(failed.titleMatches).toBeUndefined();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Cross-session search: session title match failed', expect.objectContaining({ error: expect.any(Error) }),
    );
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Cross-session search: session metadata lookup failed, results carry no titles',
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });
  it('asks the FTS source for active sessions of the current owner only (filter runs before the candidate LIMIT)', async () => {
    mocks.auth.userId = 'user-9';
    const db = mocks.database as Record<string, unknown>;
    db.searchSessionMessagesFts = vi.fn().mockReturnValue([]);
    db.countSessionMessagesFts = vi.fn().mockReturnValue({ matches: 0, sessions: 0 });
    try {
      await performCrossSessionSearch('common-word', undefined);
      expect(db.searchSessionMessagesFts).toHaveBeenCalledWith(
        'common-word',
        expect.objectContaining({ activeSessionScope: { userId: 'user-9' } }),
      );
      expect((db.searchSessionMessagesFts as ReturnType<typeof vi.fn>).mock.calls[0][1]).not.toHaveProperty('sessionIds', expect.anything());
    } finally {
      delete db.searchSessionMessagesFts;
      delete db.countSessionMessagesFts;
    }
  });
});
