// @vitest-environment jsdom
import { useRef } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { IpcEventHandlers } from '../../../src/shared/ipc';
import type { ScheduleDraftAck } from '../../../src/shared/ipc/schemas/cron';
import { acknowledgeScheduleDraft, clearScheduleDraftRequest, getScheduleDraftRequest } from '../../../src/host/cron/scheduleDraftRequests';
import { scheduleTaskModule } from '../../../src/host/tools/modules/cron/scheduleTask';
import type { ToolContext } from '../../../src/host/protocol/tools';
import { ScheduleConfirmCard } from '../../../src/renderer/components/features/chat/ChatInput/ScheduleConfirmCard';
import { useScheduleDraft } from '../../../src/renderer/components/features/chat/ChatInput/useScheduleDraft';
import { useScheduleDraftRequest } from '../../../src/renderer/components/features/chat/ChatInput/useScheduleDraftRequest';
import { useServerConnectionStore } from '../../../src/renderer/stores/serverConnectionStore';

type AgentListener = IpcEventHandlers[typeof IPC_CHANNELS.AGENT_EVENT];
const bus = vi.hoisted(() => ({
  listeners: new Set<AgentListener>(),
  generate: vi.fn(),
}));
vi.mock('../../../src/renderer/services/ipcService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/services/ipcService')>();
  return {
    ...actual,
    ipcService: {
      ...actual.ipcService,
      on: (channel: string, listener: AgentListener) => {
        if (channel === 'agent:event') bus.listeners.add(listener);
        return () => bus.listeners.delete(listener);
      },
    },
  };
});
vi.mock('../../../src/host/permissions/modes', () => ({
  getPermissionModeManager: () => ({ isUnattendedSession: () => false }),
}));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ getSession: async () => ({ origin: { kind: 'manual' } }) }),
}));

const description = 'Every two minutes, return the inventory review status';
const rawDraft = {
  name: 'Inventory review',
  scheduleType: 'every',
  schedule: { type: 'every', interval: 2, unit: 'minutes' },
  action: { type: 'agent', prompt: 'Return the inventory review status' },
};

beforeEach(() => {
  bus.generate.mockReset().mockResolvedValue(rawDraft);
  vi.stubGlobal('domainAPI', {
    invoke: async (_domain: string, action: string, payload: unknown) => {
      switch (action) {
        case 'getScheduleDraftRequest':
          return { success: true, data: getScheduleDraftRequest((payload as { sessionId: string }).sessionId) };
        case 'ackScheduleDraft':
          return { success: true, data: acknowledgeScheduleDraft(payload as ScheduleDraftAck) };
        case 'generateFromPrompt': {
          const { prompt, language } = payload as { prompt: string; language: string };
          return { success: true, data: await bus.generate(prompt, language) };
        }
      }
      throw new Error('Unexpected cron request: ' + action);
    },
  });
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 300, 120)] as unknown as DOMRectList);
});

afterEach(() => {
  clearScheduleDraftRequest('s1');
  clearScheduleDraftRequest('s2');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function start(sessionId = 's1') {
  const handler = await scheduleTaskModule.createHandler();
  let resolve!: () => void;
  const emitted = new Promise<void>((finish) => { resolve = finish; });
  const result = handler.execute({ description }, {
    sessionId,
    abortSignal: new AbortController().signal,
    emit(event) {
      if (event.type !== 'schedule_draft_requested') return;
      bus.listeners.forEach((listener) => listener({ ...event, sessionId, seq: 1, streamEpoch: 'native:test' }));
      resolve();
    },
  } as ToolContext, vi.fn());
  await emitted;
  return { result };
}

function Composer({ sessionId = 's1', busy = false, canShow = true }: {
  sessionId?: string; busy?: boolean; canShow?: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  const draft = useScheduleDraft(sessionId);
  useScheduleDraftRequest(sessionId, busy, draft, form);
  return (
    <form ref={form}>
      {canShow && draft.pendingScheduleDraft && <ScheduleConfirmCard
        draft={draft.pendingScheduleDraft}
        confirming={false}
        onConfirm={vi.fn()}
        onDismiss={draft.discardPendingScheduleDraft}
        onDraftChange={draft.storePendingScheduleDraft}
      />}
    </form>
  );
}

describe('schedule draft request recovery', () => {
  it('pulls the request when schedule_task emitted before the composer mounted, then restores without regenerating', async () => {
    expect(bus.listeners.size).toBe(0);
    const { result } = await start();
    expect(getScheduleDraftRequest('s1')).toMatchObject({ state: 'requested' });

    const first = render(<Composer />);
    expect(await screen.findByText(/确认定时任务|Confirm scheduled task/i)).toBeTruthy();
    expect(await result).toMatchObject({ ok: true });
    expect(bus.generate).toHaveBeenCalledExactlyOnceWith(description, 'zh');
    first.unmount();

    const next = render(<Composer />);
    expect(await screen.findByText(/确认定时任务|Confirm scheduled task/i)).toBeTruthy();
    next.rerender(<Composer sessionId="s2" />);
    expect(screen.queryByText(/确认定时任务|Confirm scheduled task/i)).toBeNull();
    next.rerender(<Composer />);
    expect(await screen.findByText(/确认定时任务|Confirm scheduled task/i)).toBeTruthy();
    expect(bus.generate).toHaveBeenCalledOnce();
  });

  it('waits for a busy composer and acknowledges only after the card is mounted', async () => {
    const view = render(<Composer busy canShow={false} />);
    const { result } = await start();
    expect(bus.generate).not.toHaveBeenCalled();
    view.rerender(<Composer canShow={false} />);
    await waitFor(() => expect(getScheduleDraftRequest('s1')).toMatchObject({ state: 'prepared' }));
    const settled = vi.fn();
    void result.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    view.rerender(<Composer />);
    expect(await screen.findByText(/确认定时任务|Confirm scheduled task/i)).toBeTruthy();
    expect(await result).toMatchObject({ ok: true });
  });

  it('keeps a request for another session available until that session is opened', async () => {
    const view = render(<Composer />);
    const { result } = await start('s2');
    expect(bus.generate).not.toHaveBeenCalled();
    view.rerender(<Composer sessionId="s2" />);
    expect(await screen.findByText(/确认定时任务|Confirm scheduled task/i)).toBeTruthy();
    expect(await result).toMatchObject({ ok: true });
  });

  it('pulls again when the event stream reconnects', async () => {
    const view = render(<Composer />);
    await act(async () => {});
    const listener = [...bus.listeners][0];
    bus.listeners.delete(listener);
    const { result } = await start();
    bus.listeners.add(listener);
    expect(bus.generate).not.toHaveBeenCalled();
    act(() => useServerConnectionStore.getState().markEventStreamConnected());
    expect(await screen.findByText(/确认定时任务|Confirm scheduled task/i)).toBeTruthy();
    expect(await result).toMatchObject({ ok: true });
    view.unmount();
  });

  it('reports generation failure to the waiting tool and leaves no card', async () => {
    bus.generate.mockRejectedValueOnce(new Error('Draft model unavailable'));
    render(<Composer />);
    const { result } = await start();
    expect(await result).toMatchObject({ ok: false, code: 'SCHEDULE_DRAFT_GENERATION_FAILED' });
    expect(screen.queryByText(/确认定时任务|Confirm scheduled task/i)).toBeNull();
  });
});
