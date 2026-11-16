import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// 探测/修复失败时 connector.ipc 的 host 边界：execFile 形状的 -1743 错误（message 带整段脚本）
// 不得外露到 IPC 响应；原文只进 host warn 日志；错误码结构化下发；Automation 面板由 host 打开。

const env = vi.hoisted(() => ({
  registry: {
    list: vi.fn((): unknown[] => []),
    get: vi.fn((_id: string): unknown => undefined),
    configure: vi.fn(),
    unregister: vi.fn(),
    listAvailableNativeIds: vi.fn((): string[] => ['calendar', 'mail', 'reminders', 'photos']),
  },
  config: {
    getSettings: vi.fn(() => ({ connectors: { enabledNative: ['calendar'] as string[] } })),
    updateSettings: vi.fn(async () => {}),
  },
  warn: vi.fn(),
  canOpen: vi.fn(() => true),
  open: vi.fn(async (_pane: string) => true),
  language: 'zh',
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: env.language } }) }),
}));
vi.mock('../../../src/host/connectors', () => ({ getConnectorRegistry: () => env.registry }));
vi.mock('../../../src/host/platform', () => ({ broadcastToRenderer: vi.fn() }));
vi.mock('../../../src/host/permissions/envAssist/settingsPane', () => ({
  canOpenEnvSettings: () => env.canOpen(),
  openEnvSettings: (pane: string) => env.open(pane),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), error: vi.fn(),
    warn: (...a: unknown[]) => env.warn(...a),
  }),
}));

import { registerConnectorHandlers } from '../../../src/host/ipc/connector.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;

const SCRIPT = 'tell application "Calendar" to get name of every calendar';
function execFileError(): Error {
  return Object.assign(
    new Error(`Command failed: osascript -e ${SCRIPT}\n0:50: execution error: Not authorized to send Apple events to Calendar. (-1743)\n`),
    { code: 1, killed: false, signal: null, stderr: '0:50: execution error: Not authorized to send Apple events to Calendar. (-1743)\n' },
  );
}

function register() {
  const handlers = new Map<string, HandlerFn>();
  registerConnectorHandlers(
    { handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never,
    () => null,
    () => env.config as never,
  );
  const handler = handlers.get(IPC_DOMAINS.CONNECTOR)!;
  return (action: string, payload?: unknown) => handler(null, { action, payload } as IPCRequest);
}

let call: ReturnType<typeof register>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  env.language = 'zh';
  env.config.getSettings.mockReturnValue({ connectors: { enabledNative: ['calendar'] } });
  call = register();
});
afterEach(() => vi.useRealTimers());

function connector(execute: (a: string) => Promise<unknown>, id = 'calendar', label = 'Calendar') {
  const c = {
    id, label, capabilities: [],
    getStatus: async () => ({ connected: false, readiness: 'failed', errorCode: 'not_authorized', capabilities: [] }),
    execute,
  };
  env.registry.get.mockReturnValue(c);
  env.registry.list.mockReturnValue([c]);
}

describe.each([['probe', 'probe_access'], ['repairPermission', 'repair_permissions']])('%s', (action, execAction) => {
  it('-1743 osascript 失败：响应不含命令行/脚本/Command failed，只有人话；原文进 warn 日志', async () => {
    const execute = vi.fn(async (_a: string) => { throw execFileError(); });
    connector(execute);
    const res = await call(action, { connectorId: 'calendar' });
    expect(execute).toHaveBeenCalledWith(execAction, {});
    expect(res.success).toBe(false);
    const text = JSON.stringify(res);
    expect(text).not.toMatch(/osascript|Command failed|tell application|-e /);
    expect(res.error?.message).toContain('日历 未获授权');
    expect(res.error?.message).not.toContain('控制 Calendar');
    expect(env.warn).toHaveBeenCalledWith('Connector action failed', expect.objectContaining({
      connector: 'calendar', code: 'not_authorized', detail: expect.stringContaining('-1743'),
    }));
  });

  it('非 osascript 错误（校验错误）保留原 message', async () => {
    connector(async () => { throw new Error('Calendar connector 仅在 macOS 可用。'); });
    const res = await call(action, { connectorId: 'calendar' });
    expect(res.error?.message).toBe('Calendar connector 仅在 macOS 可用。');
    expect(env.warn).not.toHaveBeenCalled();
  });
});

describe('unrecognized osascript failure', () => {
  it('不认识的失败给通用「读取失败，请稍后重试」，不含命令行', async () => {
    const err = Object.assign(new Error(`Command failed: osascript -e ${SCRIPT}\nsomething odd`), { code: 1, stderr: 'something odd' });
    connector(async () => { throw err; });
    const res = await call('probe', { connectorId: 'calendar' });
    expect(JSON.stringify(res)).not.toMatch(/osascript|Command failed|tell application/);
    expect(res.error?.message).toBe('日历：读取失败，请稍后重试');
    expect(env.warn).toHaveBeenCalledWith('Connector action failed', expect.objectContaining({ code: 'read_failed' }));
  });
});

describe.each([
  ['calendar', 'Calendar', '日历'],
  ['mail', 'Mail', '邮件'],
  ['reminders', 'Reminders', '提醒事项'],
])('%s localized failure', (id, label, chineseLabel) => {
  it.each(['zh', 'en'])('uses the app name matching %s UI for probe and repair', async (language) => {
    env.language = language;
    connector(async () => { throw execFileError(); }, id, label);
    for (const action of ['probe', 'repairPermission']) {
      const res = await call(action, { connectorId: id });
      expect(res.success).toBe(false);
      const message = res.error?.message;
      expect(message).toContain(language === 'en' ? `${label} access was denied` : `${chineseLabel} 未获授权`);
      expect(message).not.toMatch(/osascript|Command failed|tell application/);
      if (language === 'zh') expect(message).not.toContain(label);
    }
  });
});

describe('errorCode / openAutomationSettings', () => {
  it('listStatuses 下发结构化 errorCode', async () => {
    connector(async () => ({}));
    const res = await call('listStatuses');
    expect(res.data).toMatchObject([{ id: 'calendar', errorCode: 'not_authorized' }]);
  });

  it('openAutomationSettings 打开 automation 面板', async () => {
    const res = await call('openAutomationSettings');
    expect(res.data).toEqual({ opened: true });
    expect(env.open).toHaveBeenCalledWith('automation');
  });

  it('不可打开时不调 openEnvSettings', async () => {
    env.canOpen.mockReturnValueOnce(false);
    const res = await call('openAutomationSettings');
    expect(res.data).toEqual({ opened: false });
    expect(env.open).not.toHaveBeenCalled();
  });
});
