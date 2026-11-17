import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  enabledNative: [] as string[],
  runAppleScript: vi.fn(async () => 'Work\nPersonal'),
}));
// 日历自 #3483 走原生 EventKit 桥（不再走 osascript），在桥边界放假桥。
const { fake } = await vi.hoisted(async () => ({ fake: (await import('../connectors/fakeCalendarBridge')).createFakeCalendarBridge() }));
vi.mock('../../../src/host/permissions/envAssist/shellBridge/client', async (orig) => ({
  ...(await orig<object>()),
  resolveShellBridgeClientFromEnv: () => fake.client,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
  logger: { debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ connectors: { enabledNative: mocks.enabledNative } }) }),
}));

// 只在 osascript / 原生桥边界替身：连接器对象、registry、tool-search 都是真实的。
vi.mock('../../../src/host/connectors/native/osascript', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/host/connectors/native/osascript')>(),
  runAppleScript: mocks.runAppleScript,
  escapeAppleScriptString: (value: string) => value,
  parseAppleScriptDate: () => null,
  buildAppleScriptDateVar: () => [],
  sharedAppleScriptHandlers: () => [],
}));

import {
  getDeferredToolsToPreloadForTurn,
  preloadDeferredToolsForTurn,
} from '../../../src/host/agent/runtime/contextAssembly/deferredToolPreload';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { getConnectorRegistry } from '../../../src/host/connectors/registry';
import { resetCalendarConnectorReadiness } from '../../../src/host/connectors/native/calendar';
import { resetToolSearchService } from '../../../src/host/services/toolSearch';
import { getProtocolRegistry, resetProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import type { ToolModule } from '../../../src/host/protocol/tools';
import { remindersCreateSchema } from '../../../src/host/tools/modules/connectors/remindersCreate.schema';
import { mailDraftSchema } from '../../../src/host/tools/modules/connectors/mailDraft.schema';
import { calendarCreateEventSchema } from '../../../src/host/tools/modules/connectors/calendarCreateEvent.schema';

const ALL = ['reminders', 'mail', 'calendar'];
const PROMPT = '帮我加一个明天的提醒，再起草一封邮件草稿，再建一个日历日程';

function turn(content: string, toolScope?: { allowedConnectorIds?: string[] }) {
  return {
    enableToolDeferredLoading: true,
    executionIntent: undefined,
    messages: [{ id: 'm1', role: 'user' as const, content, timestamp: 1 }],
    turn: TurnState.forTest(),
    toolScope,
  };
}

function enable(ids: string[]): void {
  mocks.enabledNative = ids;
  getConnectorRegistry().configure(ids);
}

const darwin = process.platform === 'darwin';

describe.skipIf(!darwin)('native connector preload from enabledNative', () => {
  beforeEach(() => {
    mocks.warn.mockClear();
    fake.reset();
    resetCalendarConnectorReadiness();
    resetProtocolRegistry();
    for (const schema of [remindersCreateSchema, mailDraftSchema, calendarCreateEventSchema]) {
      const module: ToolModule = {
        schema,
        createHandler: () => ({ schema, async execute() { return { ok: true, output: null }; } }),
      };
      getProtocolRegistry().register(schema, async () => module);
    }
    resetToolSearchService();
    enable([]);
  });

  it('enabled + ready: write tools are preloaded without a composer selection', async () => {
    enable(ALL);
    for (const id of ALL) await getConnectorRegistry().get(id)!.execute('probe_access', {});

    const names = getDeferredToolsToPreloadForTurn(turn(PROMPT));
    expect(names).toEqual(expect.arrayContaining(['reminders_create', 'mail_draft', 'calendar_create_event']));
    expect(mocks.warn).not.toHaveBeenCalled();

    const loaded = preloadDeferredToolsForTurn(turn(PROMPT));
    expect(loaded).toEqual(expect.arrayContaining(['reminders_create', 'mail_draft', 'calendar_create_event']));
  });

  const WRITE_TOOLS = ['reminders_create', 'mail_draft', 'calendar_create_event'];
  const warnReasons = () => mocks.warn.mock.calls.map((call) => String(call[0]));

  it('enabled + unchecked (post-restart): write tools are still preloaded, no warn', () => {
    enable(ALL);
    for (const id of ALL) expect(getConnectorRegistry().get(id)!.getCachedStatus!().readiness).toBe('unchecked');

    expect(getDeferredToolsToPreloadForTurn(turn(PROMPT))).toEqual(expect.arrayContaining(WRITE_TOOLS));
    expect(preloadDeferredToolsForTurn(turn(PROMPT))).toEqual(expect.arrayContaining(WRITE_TOOLS));
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('enabled + failed probe: reminders/mail not preloaded (readiness-failed); unauthorized calendar keeps its tools', async () => {
    enable(ALL);
    mocks.runAppleScript.mockRejectedValueOnce(new Error('not authorized'));
    await expect(getConnectorRegistry().get('reminders')!.execute('probe_access', {})).rejects.toThrow();
    mocks.runAppleScript.mockRejectedValueOnce(new Error('not authorized'));
    await expect(getConnectorRegistry().get('mail')!.execute('probe_access', {})).rejects.toThrow();
    // 日历未授权不算「坏了」：保持 unchecked、工具照常预载，调用时出授权卡（#3483）
    fake.state.status = 2;
    await getConnectorRegistry().get('calendar')!.execute('probe_access', {});
    for (const id of ['reminders', 'mail']) expect(getConnectorRegistry().get(id)!.getCachedStatus!().readiness).toBe('failed');
    expect(getConnectorRegistry().get('calendar')!.getCachedStatus!().readiness).toBe('unchecked');

    const names = getDeferredToolsToPreloadForTurn(turn(PROMPT));
    expect(names).toHaveLength(4);
    expect(names).toEqual(expect.arrayContaining([
      'calendar', 'calendar_create_event', 'calendar_update_event', 'calendar_delete_event',
    ]));
    expect(names).toContain('calendar_create_event');
    expect(names).not.toContain('reminders_create');
    expect(names).not.toContain('mail_draft');
    expect(warnReasons().filter((w) => w.includes('reason: readiness-failed'))).toHaveLength(2);
  });

  it('enabled but platform unavailable: not preloaded, warns readiness-unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      enable([]);
      enable(ALL);
      for (const id of ALL) expect(getConnectorRegistry().get(id)!.getCachedStatus!().readiness).toBe('unavailable');

      expect(getDeferredToolsToPreloadForTurn(turn(PROMPT))).toEqual([]);
      expect(warnReasons().filter((w) => w.includes('reason: readiness-unavailable'))).toHaveLength(3);
    } finally {
      Object.defineProperty(process, 'platform', original);
      enable([]);
    }
  });

  it('enabled in config but absent from the registry: exposes only the read tool, warns with not-registered', () => {
    mocks.enabledNative = ['reminders'];
    getConnectorRegistry().configure([]);

    expect(getDeferredToolsToPreloadForTurn(turn('加个提醒'))).toEqual(['reminders']);
    const warns = mocks.warn.mock.calls.map((call) => String(call[0]));
    expect(warns.some((w) => w.includes('reason: not-registered') && w.includes('read tool'))).toBe(true);
  });

  it('registry configured after the first turn: the next turn gets all three connectors write tools', () => {
    mocks.enabledNative = ALL;
    getConnectorRegistry().configure([]);

    expect(getDeferredToolsToPreloadForTurn(turn(PROMPT)).sort()).toEqual(['calendar', 'mail', 'reminders']);
    expect(warnReasons().filter((w) => w.includes('reason: not-registered'))).toHaveLength(3);

    getConnectorRegistry().configure(ALL);
    mocks.warn.mockClear();

    const names = getDeferredToolsToPreloadForTurn(turn(PROMPT));
    expect(names).toEqual(expect.arrayContaining(WRITE_TOOLS));
    expect(preloadDeferredToolsForTurn(turn(PROMPT))).toEqual(expect.arrayContaining(WRITE_TOOLS));
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('not enabled: only the read tool of each matched connector is preloaded, warns not-enabled', () => {
    enable([]);

    const names = getDeferredToolsToPreloadForTurn(turn(PROMPT));
    expect(names.sort()).toEqual(['calendar', 'mail', 'reminders']);
    for (const w of WRITE_TOOLS) expect(names).not.toContain(w);
    expect(warnReasons().filter((w) => w.includes('reason: not-enabled'))).toHaveLength(3);
  });

  it('calendar off + schedule question: calendar read tool reaches both consumers, tool returns the not-connected text', async () => {
    enable([]);
    const prompt = '我今天有什么日程';
    expect(getDeferredToolsToPreloadForTurn(turn(prompt))).toEqual(['calendar']);

    const { getTextForegroundToolNamesForPrompt } = await import('../../../src/host/app/sessionCommandCenterBrain');
    const foreground = getTextForegroundToolNamesForPrompt(prompt);
    expect(foreground).toContain('calendar');
    expect(foreground).not.toContain('calendar_create_event');
    expect(getTextForegroundToolNamesForPrompt("what's on my calendar today?")).toContain('calendar');

    // 真实 registry 为空 → 真实 calendar 工具走 NOT_INITIALIZED。
    const { calendarModule } = await import('../../../src/host/tools/modules/connectors/calendar');
    const handler = await calendarModule.createHandler();
    const ctx = {
      sessionId: 's', workingDir: process.cwd(), abortSignal: new AbortController().signal,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, emit: () => undefined,
    } as never;
    const result = await handler.execute({ action: 'list_events' }, ctx, async () => ({ allow: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_INITIALIZED');
      expect(result.error).toContain('Calendar is not connected');
      expect(result.error).toContain('never state that there are no events');
      expect(result.error).toContain('能力中心 > 连接器');
      expect(result.error).not.toContain('设置 > 连接器');
    }
  });

  it('not enabled + composer selected another connector: calendar read tool is not added', () => {
    enable([]);
    expect(getDeferredToolsToPreloadForTurn(turn('我今天有什么日程', { allowedConnectorIds: ['feishu'] }))).not.toContain('calendar');
  });

  it('enabled + ready but the prompt has no reminder/mail/calendar wording: not preloaded', async () => {
    enable(ALL);
    for (const id of ALL) await getConnectorRegistry().get(id)!.execute('probe_access', {});

    expect(getDeferredToolsToPreloadForTurn(turn('帮我重构这个函数'))).toEqual([]);
  });

  it('respects an explicit composer selection of a different connector', async () => {
    enable(ALL);
    for (const id of ALL) await getConnectorRegistry().get(id)!.execute('probe_access', {});

    const names = getDeferredToolsToPreloadForTurn(turn(PROMPT, { allowedConnectorIds: ['feishu'] }));
    expect(names).not.toContain('reminders_create');
  });

  // N-FG-CONNECTOR-TOOLS：文字前台 allowlist 的连接器扩展必须复用本文件的判据真源
  // （connectors/nativeConnectorIntent.ts），不许长出第二份正则副本。两侧输出对不上
  // 即红——「修了预载漏了前台」或反之的复发形态。
  it('文字前台 allowlist 与 deferred 预载共用同一意图判据（单一真源）', async () => {
    enable(ALL);
    const { getTextForegroundToolNamesForPrompt } = await import('../../../src/host/app/sessionCommandCenterBrain');
    const { getNativeConnectorToolNamesForIntent } = await import('../../../src/host/connectors/nativeConnectorIntent');
    const { getTextForegroundToolNames } = await import('../../../src/host/tools/protocolRegistry');

    const prompts = [
      PROMPT,
      '加个提醒',
      '给 a@b.c 发封邮件说会议改期',
      '解释一下这个仓库',
      '帮我看看今天有什么安排',
    ];
    for (const prompt of prompts) {
      const intentNames = getNativeConnectorToolNamesForIntent({ userText: prompt });
      const foreground = getTextForegroundToolNamesForPrompt(prompt);
      for (const name of intentNames) {
        expect(foreground).toContain(name);
      }
      if (intentNames.length === 0) {
        expect(foreground).toEqual(getTextForegroundToolNames());
      }
    }
  });
});
