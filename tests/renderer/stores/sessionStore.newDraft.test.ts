import { describe, expect, it } from 'vitest';
import { findReusableNewSessionDraft, isBlankNewSession } from '../../../src/renderer/stores/sessionStore';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

function session(overrides: Partial<SessionWithMeta>): SessionWithMeta {
  return {
    id: 'session-1',
    title: '新对话',
    modelConfig: { provider: 'openai', model: 'gpt-5.4' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
    workbenchSnapshot: {
      summary: '纯对话',
      labels: [],
      recentToolNames: [],
    },
    ...overrides,
  };
}

describe('findReusableNewSessionDraft', () => {
  it('reuses the current empty new session draft', () => {
    const draft = session({ id: 'draft-1', workingDirectory: '/repo/code-agent' });

    expect(findReusableNewSessionDraft({
      sessions: [draft],
      currentSessionId: 'draft-1',
      messages: [],
      todos: [],
      workingDirectory: '/repo/code-agent',
    })?.id).toBe('draft-1');
  });

  it('does not reuse sessions that already have messages', () => {
    expect(findReusableNewSessionDraft({
      sessions: [session({ id: 'used-1', messageCount: 1 })],
      currentSessionId: 'used-1',
      messages: [],
      todos: [],
      workingDirectory: null,
    })).toBeNull();
  });

  it('treats meta-only current messages as an unused draft', () => {
    const draft = session({ id: 'draft-1' });

    expect(findReusableNewSessionDraft({
      sessions: [draft],
      currentSessionId: 'draft-1',
      messages: [{
        id: 'meta-1',
        role: 'user',
        content: 'loop internal prompt',
        timestamp: 1,
        isMeta: true,
      }],
      todos: [],
      workingDirectory: null,
    })?.id).toBe('draft-1');
  });
});

describe('blank placeholder titles in either UI language', () => {
  it.each(['新对话', 'New conversation', 'New Chat', '新会话', ''])('recognises %j without changing stored text', (title) => {
    const draft = session({ title });
    expect(isBlankNewSession(draft)).toBe(true);
    expect(findReusableNewSessionDraft({ sessions: [draft], currentSessionId: draft.id, messages: [], todos: [] })).toBe(draft);
    expect(draft.title).toBe(title);
    expect(isBlankNewSession({ ...draft, messageCount: 1 })).toBe(false);
    expect(isBlankNewSession({ ...draft, turnCount: 1 })).toBe(false);
    expect(isBlankNewSession({ ...draft, isArchived: true })).toBe(false);
  });
  it('keeps a named empty conversation distinct from a blank draft', () => {
    expect(isBlankNewSession(session({ title: 'Trip planning' }))).toBe(false);
  });
});
