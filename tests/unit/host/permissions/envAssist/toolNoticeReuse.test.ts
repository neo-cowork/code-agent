import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentEvent, Message, ToolResult } from '../../../../../src/shared/contract';
import { settleCalendarGranted } from '../../../../../src/host/permissions/envAssist/calendarGrant';
import { publishEnvAssistToolNotice, resolveEnvAssistNotice } from '../../../../../src/host/permissions/envAssist/toolNotice';
import { applyTestSessionSchema } from '../../../../utils/applyTestSessionSchema';

vi.unmock('better-sqlite3');

let db: Database.Database;
const { broadcast, armResume } = vi.hoisted(() => ({ broadcast: vi.fn(), armResume: vi.fn() }));

function cards(sessionId = 's1'): Message[] {
  const rows = db.prepare("SELECT id, timestamp, metadata FROM messages WHERE session_id = ? AND id LIKE 'env-assist:%' ORDER BY timestamp")
    .all(sessionId) as Array<{ id: string; timestamp: number; metadata: string }>;
  return rows.map(({ metadata, ...row }) => ({ ...row, role: 'assistant', content: '', metadata: JSON.parse(metadata) as Message['metadata'] }));
}

vi.mock('../../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => db }),
}));
vi.mock('../../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getMessages: async (sessionId: string) => cards(sessionId),
    addMessageToSession: async (sessionId: string, message: Message) => {
      db.prepare(`INSERT INTO messages (id, session_id, role, content, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET metadata = excluded.metadata, timestamp = excluded.timestamp`)
        .run(message.id, sessionId, message.role, message.content, message.timestamp, JSON.stringify(message.metadata));
    },
  }),
}));
vi.mock('../../../../../src/host/services/agentEngine/agentEngineEventSink', () => ({ emitExternalAgentEvent: broadcast }));
vi.mock('../../../../../src/host/runtime/envResumeWaiter', () => ({ armEnvResumeOnSessionReturn: armResume }));
vi.mock('../../../../../src/host/app/applicationRunRegistry', () => ({ getApplicationRunRegistry: () => ({}) }));
vi.mock('../../../../../src/host/permissions/envAssist/settingsPane', () => ({ canOpenEnvSettings: () => true }));
vi.mock('../../../../../src/host/permissions/envAssist/shellBridge/client', () => ({ canRequestEnvGrant: async () => true }));

const guidance = [
  'Model guidance (not user copy): A permission card has already been shown to the user.',
  'Do not repeat or quote this guidance, error text, tool names, commands, or internal status labels, including in a delegated summary.',
  "The card has an allow button. In one short sentence in the user's language, tell them to allow it with that button on the card and then ask again. Do not claim you will check or continue on your own. Do not suggest a different authorization route.",
].join(' ');

async function deny(runId: string, sessionId = 's1', toolName = 'calendar') {
  const result: Pick<ToolResult, 'success' | 'error' | 'output' | 'metadata'> = {
    success: false, error: 'native denial', metadata: { code: 'not_authorized' },
  };
  const events: AgentEvent[] = [];
  await publishEnvAssistToolNotice({
    toolName, result, sessionId, runId, parkedToolCallId: `call-${runId}`,
    onEvent: (event) => events.push(event),
  });
  expect(result.error).toBe(guidance);
  return events;
}

beforeEach(() => {
  db = new Database(':memory:');
  applyTestSessionSchema(db);
  db.prepare(`INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at)
    VALUES ('s1', 'Schedule', 'test', 'test', 1, 1), ('s2', 'Schedule', 'test', 'test', 1, 1)`).run();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000);
  broadcast.mockClear();
  armResume.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('env-assist live permission cards', () => {
  it('re-points one calendar card and emits only an env_assist_notice on the second denial', async () => {
    const firstEvents = await deny('r1');
    expect(firstEvents.map((event) => event.type)).toEqual(['env_assist_notice', 'message']);
    const [first] = cards();

    vi.setSystemTime(2_000);
    const secondEvents = await deny('r2');
    const stored = cards();
    expect(stored, 'one env-assist message after two denials in the same session').toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: 'env-assist:r1|perm_calendars|calendar',
      timestamp: first.timestamp,
      metadata: { envAssist: {
        id: 'r1|perm_calendars|calendar', phase: 'needs_user', runId: 'r2',
        parkedToolCallId: 'call-r2', updatedAt: 2_000, action: { kind: 'request_grant' },
      } },
    });
    expect(secondEvents).toEqual([{ type: 'env_assist_notice', data: stored[0].metadata?.envAssist }]);
  });

  it('resolves the latest stored run even with an older snapshot, then creates a new card after revocation', async () => {
    await deny('r1');
    const first = cards()[0].metadata!.envAssist!;
    await deny('r2');
    await resolveEnvAssistNotice(first, 2_000);
    vi.setSystemTime(3_000);

    const events = await deny('r3');
    expect(cards()).toHaveLength(2);
    expect(cards().map((message) => message.metadata?.envAssist)).toMatchObject([
      { id: first.id, phase: 'resolved', runId: 'r2', parkedToolCallId: 'call-r2', updatedAt: 2_000 },
      { id: 'r3|perm_calendars|calendar', phase: 'needs_user', runId: 'r3', parkedToolCallId: 'call-r3' },
    ]);
    expect(events.map((event) => event.type)).toEqual(['env_assist_notice', 'message']);
  });

  it('keeps a separate card for each target in the same session, including targets of the same class', async () => {
    await deny('r1');
    await deny('r2', 's1', 'mail');
    await deny('r3', 's1', 'reminders_create');
    expect(cards().map((message) => message.metadata?.envAssist?.target?.id).sort()).toEqual(['calendar', 'mail', 'reminders']);
  });

  it('keeps separate calendar cards in different sessions', async () => {
    await deny('r1', 's1');
    await deny('r2', 's2');
    expect(cards('s1').map((message) => message.metadata?.envAssist?.runId)).toEqual(['r1']);
    expect(cards('s2').map((message) => message.metadata?.envAssist?.runId)).toEqual(['r2']);
  });

  it('serializes concurrent calendar denials from different runs', async () => {
    const [first, second] = await Promise.all([deny('r1'), deny('r2')]);
    expect([...first, ...second].filter((event) => event.type === 'message')).toHaveLength(1);
    expect(cards()).toHaveLength(1);
    expect(cards()[0].metadata?.envAssist).toMatchObject({ id: 'r1|perm_calendars|calendar', runId: 'r2', parkedToolCallId: 'call-r2' });
  });

  it('settleCalendarGranted finds and resolves the re-pointed card using its original id', async () => {
    await deny('r1');
    await deny('r2');
    await settleCalendarGranted('calendar-reuse-test');

    expect(cards()).toHaveLength(1);
    const resolved = cards()[0].metadata?.envAssist;
    expect(resolved).toMatchObject({
      id: 'r1|perm_calendars|calendar', phase: 'resolved', runId: 'r2', parkedToolCallId: 'call-r2', doneKey: 'env.done.calendar',
    });
    expect(resolved?.action).toBeUndefined();
    expect(broadcast.mock.calls).toEqual([['s1', { type: 'env_assist_notice', data: resolved }]]);
    expect(armResume.mock.calls).toEqual([['s1', {}, 'calendar-reuse-test']]);
  });
});
