import { describe, it, expect, vi } from 'vitest';
import type { EnvAssistNotice } from '../../../../src/shared/contract';
const calls = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<object>(), execFile: calls.exec }));
import { registerEnvAssistHandlers } from '../../../../src/host/ipc/envAssist.ipc';
import { ipcHost } from '../../../../src/host/platform';
import { openEnvSettings } from '../../../../src/host/envAssist/settingsPane';
import type { HandlerFn } from '../../../../src/host/platform';

describe('envAssist.act native opening through installed IPC', () => {
  it.each([
    ['automation', 'Privacy_Automation'], ['accessibility', 'Privacy_Accessibility'], ['screenCapture', 'Privacy_ScreenCapture'],
  ] as const)('opens only the current %s card URL', async (pane, suffix) => {
    let handler: HandlerFn | undefined;
    vi.spyOn(ipcHost, 'handle').mockImplementation((_channel, installed) => { handler = installed; });
    calls.exec.mockReset().mockImplementation((_command, _args, callback) => { callback(null); });
    const notice: EnvAssistNotice = {
      id: 'current', sessionId: 'session', runId: 'run', class: 'perm_automation', phase: 'needs_user',
      sentenceKey: 'env.sentence.calendar', action: { kind: 'open_settings_pane', labelKey: 'env.allow.calendar', payload: { pane } },
      resume: { mode: 'manual' }, updatedAt: 1,
    };
    registerEnvAssistHandlers({ available: () => true, open: openEnvSettings, findNotice: async (id) => id === notice.id ? notice : undefined });
    const payload = { noticeId: notice.id, actionKind: notice.action!.kind, payload: { pane } };
    expect(await handler!({} as never, { action: 'act', payload })).toMatchObject({ success: true, data: { status: 'opened' } });
    expect(calls.exec).toHaveBeenCalledExactlyOnceWith('open', [`x-apple.systempreferences:com.apple.preference.security?${suffix}`], expect.any(Function));
    expect(await handler!({} as never, { action: 'act', payload: { ...payload, noticeId: 'forged' } })).toMatchObject({ data: { status: 'rejected' } });
    expect(await handler!({} as never, { action: 'act', payload: { ...payload, actionKind: 'request_grant' } })).toMatchObject({ data: { status: 'rejected' } });
    expect(calls.exec).toHaveBeenCalledTimes(1);
  });
});
