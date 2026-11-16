// N-CALENDAR-ONE-PERMISSION-EVENTKIT：日历只有一项授权，任何入口授权后所有会话的日历卡一起收口、停住的任务续做。
// Evidence class: hermetic-protocol（假 EventKit 桥 + 内存消息库 + 生产 IPC / classify / settle）。真系统框是真机步骤（验收⑤）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Message } from '../../../../../src/shared/contract';
import type { EnvAssistNotice } from '../../../../../src/shared/contract/envAssist';
import type { PassiveBridge, PromptingBridge } from '../../../../../src/host/permissions/envAssist/probes/types';

const h = vi.hoisted(() => ({
  bySession: new Map<string, Message[]>(),
  events: [] as Array<{ sessionId: string; event: AgentEvent }>,
  armed: [] as Array<{ sessionId: string; entry: string }>,
  setting: false,
}));
vi.mock('../../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: () => ({ prepare: (sql: string) => ({
    all: () => {
      expect(sql).toContain("LIKE 'env-assist:%|calendar'");
      return [...h.bySession].flatMap(([sessionId, messages]) => messages
        .filter((m) => m.id.startsWith('env-assist:') && m.id.endsWith('|calendar'))
        .map((m) => ({ id: m.id, session_id: sessionId })));
    },
  }) }) }),
}));
vi.mock('../../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getMessages: async (sessionId: string) => (h.bySession.get(sessionId) ?? []).map((m) => structuredClone(m)),
    addMessageToSession: async (sessionId: string, m: Message) => {
      const list = h.bySession.get(sessionId) ?? [];
      const i = list.findIndex((x) => x.id === m.id);
      if (i >= 0) list[i] = m; else list.push(m);
      h.bySession.set(sessionId, list);
    },
  }),
}));
vi.mock('../../../../../src/host/services/agentEngine/agentEngineEventSink', () => ({
  emitExternalAgentEvent: (sessionId: string, event: AgentEvent) => { h.events.push({ sessionId, event }); },
}));
vi.mock('../../../../../src/host/runtime/envResumeWaiter', () => ({
  armEnvResumeOnSessionReturn: (sessionId: string, _registry: unknown, entry: string) => { h.armed.push({ sessionId, entry }); },
}));
vi.mock('../../../../../src/host/app/applicationRunRegistry', () => ({ getApplicationRunRegistry: () => ({}) }));
vi.mock('../../../../../src/host/permissions/envAssist/shellBridge/client', async (orig) => ({
  ...(await orig<object>()), canRequestEnvGrant: async () => true, resolveShellBridgeClientFromEnv: () => null,
}));
vi.mock('../../../../../src/host/permissions/envAssist/settingsPane', () => ({ canOpenEnvSettings: () => true, openEnvSettings: vi.fn(async () => true) }));

import { classifyEnvBlocker } from '../../../../../src/host/permissions/envAssist/classify';
import { settleCalendarGranted } from '../../../../../src/host/permissions/envAssist/calendarGrant';
import { registerEnvAssistHandlers } from '../../../../../src/host/ipc/envAssist.ipc';
import { ipcHost, type HandlerFn } from '../../../../../src/host/platform';

const ek = { status: 0 as 0 | 2 | 3, prompts: 0 };
const passive = { EKAuthorizationStatusForEvents: async () => ek.status } as unknown as PassiveBridge;
const grant = { requestFullAccessToEvents: async () => { ek.prompts++; ek.status = 3; } } as unknown as PromptingBridge;

function card(sessionId: string, runId: string, klass: 'perm_calendars' | 'perm_automation' = 'perm_calendars'): EnvAssistNotice {
  const notice: EnvAssistNotice = {
    id: `${runId}|${klass}|calendar`, sessionId, runId, class: klass,
    target: { id: 'calendar', labelKey: 'env.target.calendar' }, phase: 'needs_user', sentenceKey: 'env.sentence.calendar',
    action: { kind: 'request_grant', labelKey: 'env.allow.calendar', payload: { pane: klass === 'perm_calendars' ? 'calendars' : 'automation' } },
    resume: { mode: 'manual' }, updatedAt: 1,
  };
  const list = h.bySession.get(sessionId) ?? [];
  list.push({ id: `env-assist:${notice.id}`, role: 'assistant', content: '', timestamp: 1, metadata: { envAssist: notice } });
  h.bySession.set(sessionId, list);
  return notice;
}
const phaseOf = (n: EnvAssistNotice) => h.bySession.get(n.sessionId)!.find((m) => m.id === `env-assist:${n.id}`)!.metadata!.envAssist!.phase;

let handler: HandlerFn;
const call = async (action: string, payload: unknown) => ((await handler({} as never, { action, payload })) as { data: unknown }).data;

beforeEach(() => {
  h.bySession.clear(); h.events.length = 0; h.armed.length = 0; h.setting = false;
  Object.assign(ek, { status: 0, prompts: 0 });
  vi.spyOn(ipcHost, 'handle').mockImplementation((_c, fn) => { handler = fn; });
  registerEnvAssistHandlers({
    available: () => true, open: vi.fn(async () => true), passiveBridge: passive, grantBridge: grant, sleep: async () => undefined,
    findNotice: async (id) => [...h.bySession.values()].flat().find((m) => m.id === `env-assist:${id}`)?.metadata?.envAssist,
    calendarReminderSetting: { read: () => h.setting, write: async (on) => { h.setting = on; } },
  });
});

describe('one calendar permission', () => {
  it('classify: every calendar tool (reads and writes) asks for perm_calendars, never the Apple-events automation pane', () => {
    for (const toolName of ['calendar', 'calendar_create_event', 'calendar_update_event', 'calendar_delete_event']) {
      const notice = classifyEnvBlocker({ toolName, result: { success: false, metadata: { code: 'not_authorized' } }, sessionId: 's', runId: 'r' });
      expect(notice, toolName).toMatchObject({ class: 'perm_calendars', target: { id: 'calendar' }, action: { payload: { pane: 'calendars' } } });
    }
    // mail / reminders are still Apple events
    expect(classifyEnvBlocker({ toolName: 'mail', result: { success: false, metadata: { code: 'not_authorized' } }, sessionId: 's', runId: 'r' }))
      .toMatchObject({ class: 'perm_automation', action: { payload: { pane: 'automation' } } });
  });

  it('settleCalendarGranted closes every waiting calendar card in every session (new and pre-switch cards) and arms each session once', async () => {
    const a = card('s-a', 'run-a');
    const b = card('s-b', 'run-b', 'perm_automation'); // parked before the switch
    const b2 = card('s-b', 'run-b2');
    await settleCalendarGranted('test');
    expect([phaseOf(a), phaseOf(b), phaseOf(b2)]).toEqual(['resolved', 'resolved', 'resolved']);
    expect(h.armed).toEqual([{ sessionId: 's-a', entry: 'test' }, { sessionId: 's-b', entry: 'test' }]);
    expect(h.events.filter((e) => e.event.type === 'env_assist_notice')).toHaveLength(3);
    // Idempotent: nothing left to close, nothing re-armed.
    await settleCalendarGranted('again');
    expect(h.armed).toHaveLength(2);
  });

  it('turning the reminder switch on (one dialog) closes the chat card in another session and wakes its parked run', async () => {
    const chat = card('s-chat', 'run-chat');
    expect(await call('enableSettingGrant', { setting: 'meetingCalendarReminder' })).toEqual({ on: true });
    expect(ek.prompts).toBe(1);
    expect(h.setting).toBe(true);
    expect(phaseOf(chat)).toBe('resolved');
    expect(h.armed).toEqual([{ sessionId: 's-chat', entry: 'meeting_reminder_setting' }]);
  });

  it('switch and card clicked while one dialog is up: one dialog, both get the same answer (11-15 real run: second click re-prompted and hung)', async () => {
    const chat = card('s-chat', 'run-chat');
    const [switched, clicked] = await Promise.all([
      call('enableSettingGrant', { setting: 'meetingCalendarReminder' }),
      call('act', { noticeId: chat.id, actionKind: 'request_grant', payload: { pane: 'calendars' } }),
    ]);
    expect(ek.prompts).toBe(1);
    expect(switched).toEqual({ on: true });
    expect(clicked).toMatchObject({ status: 'checked', outcome: { status: 'granted' } });
    expect(phaseOf(chat)).toBe('resolved');
  });

  it('a card resolved from another entry hands its done copy back on recheck (chat missed the broadcast while on the settings page)', async () => {
    const first = card('s-1', 'run-1');
    const replaced = card('s-1', 'run-0'); // the superseded parked run's card in the same session
    ek.status = 3;
    expect(await call('enableSettingGrant', { setting: 'meetingCalendarReminder' })).toEqual({ on: true });
    for (const n of [first, replaced]) {
      expect(await call('recheck', { noticeId: n.id })).toMatchObject({
        status: 'checked', outcome: { status: 'granted' }, notice: { id: n.id, phase: 'resolved', doneKey: 'env.done.calendar' },
      });
    }
  });

  it('granted in System Settings: the settings page recheck also closes the chat cards (no prompt)', async () => {
    const chat = card('s-chat', 'run-chat');
    h.setting = true;
    ek.status = 3;
    expect(await call('recheckSettingGrant', { setting: 'meetingCalendarReminder' })).toEqual({ on: true });
    expect(phaseOf(chat)).toBe('resolved');
    expect(ek.prompts).toBe(0);
  });

  it('clicking allow on one chat card closes the other sessions\' calendar cards too', async () => {
    const first = card('s-1', 'run-1');
    const second = card('s-2', 'run-2');
    expect(await call('act', { noticeId: first.id, actionKind: 'request_grant', payload: { pane: 'calendars' } }))
      .toMatchObject({ status: 'checked', outcome: { status: 'granted' } });
    expect(ek.prompts).toBe(1);
    expect([phaseOf(first), phaseOf(second)]).toEqual(['resolved', 'resolved']);
    expect(h.armed.map((x) => x.sessionId).sort()).toEqual(['s-1', 's-2']);
  });

  it('revoked later: the switch reads off (revoked) and a new failure opens a fresh card again', async () => {
    h.setting = true;
    ek.status = 2;
    expect(await call('recheckSettingGrant', { setting: 'meetingCalendarReminder' })).toEqual({ on: false, reason: 'revoked' });
    expect(classifyEnvBlocker({ toolName: 'calendar', result: { success: false, code: 'not_authorized' }, sessionId: 's', runId: 'r2' }))
      .toMatchObject({ phase: 'needs_user', class: 'perm_calendars' });
  });
});
