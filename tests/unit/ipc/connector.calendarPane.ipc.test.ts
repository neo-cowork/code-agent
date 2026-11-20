// Calendar denial reaches the card through listStatuses, and the card's button opens Privacy > Calendars.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

const env = vi.hoisted(() => ({
  body: { status: 0, raw: 0, answer: null as boolean | null },
  list: [] as unknown[],
  canOpen: true,
  opened: [] as string[],
}));

vi.mock('../../../src/host/connectors', () => ({
  getConnectorRegistry: () => ({
    list: () => env.list,
    get: (id: string) => env.list.find((item) => (item as { id: string }).id === id),
    configure: vi.fn(),
    unregister: vi.fn(),
    listAvailableNativeIds: () => ['calendar', 'mail', 'reminders', 'photos'],
  }),
}));
vi.mock('../../../src/host/platform', () => ({ broadcastToRenderer: vi.fn() }));
vi.mock('../../../src/host/permissions/envAssist/settingsPane', () => ({
  canOpenEnvSettings: () => env.canOpen,
  openEnvSettings: async (pane: string) => { env.opened.push(pane); return true; },
}));
vi.mock('../../../src/host/permissions/envAssist/shellBridge/client', async (orig) => ({
  ...(await orig<typeof import('../../../src/host/permissions/envAssist/shellBridge/client')>()),
  resolveShellBridgeClientFromEnv: () => ({
    post: async (path: string) => {
      if (path !== '/v1/passive/calendar') throw new Error(`unexpected ${path}`);
      return env.body;
    },
  }),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { calendarConnector, resetCalendarConnectorReadiness } from '../../../src/host/connectors/native/calendar';
import { registerConnectorHandlers, stopConnectorStatusWatcher } from '../../../src/host/ipc/connector.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;

const DENIED_DETAIL = '日历访问被拒绝了：请在「系统设置 → 隐私与安全性 → 日历」里允许 Neo。';
const UNDECIDED_DETAIL = '还没有允许 Neo 访问日历；用到日历时会请你允许一次。';
const WRITE_ONLY_DETAIL = '日历只给了「仅添加事件」：请在「系统设置 → 隐私与安全性 → 日历」里改成「完全访问」。';

function register() {
  const handlers = new Map<string, HandlerFn>();
  registerConnectorHandlers(
    { handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never,
    () => null,
    () => ({ getSettings: () => ({ connectors: { enabledNative: ['calendar'] } }), updateSettings: async () => {} }) as never,
  );
  const handler = handlers.get(IPC_DOMAINS.CONNECTOR)!;
  return (action: string, payload?: unknown) => handler(null, { action, payload } as IPCRequest);
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform');

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  env.body = { status: 0, raw: 0, answer: null };
  env.canOpen = true;
  env.opened = [];
  env.list = [];
  resetCalendarConnectorReadiness();
});

afterEach(() => {
  stopConnectorStatusWatcher();
  vi.useRealTimers();
  if (platform) Object.defineProperty(process, 'platform', platform);
  resetCalendarConnectorReadiness();
});

/** Register while the status list is empty so the watcher's first poll cannot race the assertions. */
async function registerQuietly() {
  const call = register();
  await Promise.resolve();
  await Promise.resolve();
  stopConnectorStatusWatcher();
  env.list = [calendarConnector];
  return call;
}

describe('handleListStatuses + buildCalendarStatus', () => {
  it('denied keeps unchecked and names the calendars pane; undecided and granted do not', async () => {
    const call = await registerQuietly();

    env.body = { status: 0, raw: 0, answer: false };
    resetCalendarConnectorReadiness();
    const denied = ((await call('listStatuses')).data as Array<Record<string, unknown>>)[0];
    expect(denied).toMatchObject({
      id: 'calendar',
      readiness: 'unchecked',
      settingsPane: 'calendars',
      detail: DENIED_DETAIL,
    });
    expect(denied.readiness).not.toBe('failed');
    expect(typeof denied.checkedAt).toBe('number');

    env.body = { status: 4, raw: 4, answer: null };
    resetCalendarConnectorReadiness();
    const writeOnly = ((await call('listStatuses')).data as Array<Record<string, unknown>>)[0];
    expect(writeOnly).toMatchObject({
      readiness: 'unchecked',
      settingsPane: 'calendars',
      detail: WRITE_ONLY_DETAIL,
    });

    env.body = { status: 0, raw: 0, answer: null };
    resetCalendarConnectorReadiness();
    const undecided = ((await call('listStatuses')).data as Array<Record<string, unknown>>)[0];
    expect(undecided).toMatchObject({ readiness: 'unchecked', detail: UNDECIDED_DETAIL });
    expect(undecided.settingsPane).toBeUndefined();
    expect(typeof undecided.checkedAt).toBe('number');

    env.body = { status: 3, raw: 0, answer: true };
    resetCalendarConnectorReadiness();
    const granted = ((await call('listStatuses')).data as Array<Record<string, unknown>>)[0];
    expect(granted).toMatchObject({ readiness: 'ready' });
    expect(granted.settingsPane).toBeUndefined();

    process.stdout.write(`③ denied=${JSON.stringify({ readiness: denied.readiness, settingsPane: denied.settingsPane, detail: denied.detail })} undecided.settingsPane=${String(undecided.settingsPane)} granted.settingsPane=${String(granted.settingsPane)} writeOnly.settingsPane=${String(writeOnly.settingsPane)}\n`);
  });
});

describe('openCalendarSettings', () => {
  it('opens the calendars pane, not automation', async () => {
    const call = await registerQuietly();
    const res = await call('openCalendarSettings');
    expect(res.data).toEqual({ opened: true });
    expect(env.opened).toEqual(['calendars']);
    process.stdout.write(`④ openEnvSettings pane=${env.opened[0]}\n`);
  });

  it('does not call openEnvSettings when the desktop cannot open settings', async () => {
    env.canOpen = false;
    const call = await registerQuietly();
    const res = await call('openCalendarSettings');
    expect(res.data).toEqual({ opened: false });
    expect(env.opened).toEqual([]);
  });
});
