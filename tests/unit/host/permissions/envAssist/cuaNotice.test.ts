// Evidence class: hermetic-protocol (fake MCP session + fake bridges). A headless run cannot trigger real TCC.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Message, ToolResult } from '../../../../../src/shared/contract';
import type { EnvAssistNotice } from '../../../../../src/shared/contract/envAssist';

const mocks = vi.hoisted(() => ({
  messages: [] as Message[],
  structured: { accessibility: true, screen_recording: false, screen_recording_capturable: false, direct_capture_status: 'unknown', source: 'helper' } as Record<string, unknown>,
  calls: [] as Array<{ server: string; tool: string; args: Record<string, unknown> }>,
  status: 'connected',
}));
vi.mock('../../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    getMessages: async () => mocks.messages,
    addMessageToSession: async (_s: string, m: Message) => { mocks.messages.push(m); },
  }),
}));
vi.mock('../../../../../src/host/permissions/envAssist/settingsPane', () => ({ canOpenEnvSettings: () => true, openEnvSettings: vi.fn() }));
vi.mock('../../../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...await importOriginal<object>(), createLogger: () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    getServerState: () => ({ status: mocks.status }),
    callTool: async (_id: string, server: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> => {
      mocks.calls.push({ server, tool, args });
      return { toolCallId: _id, success: true, output: 'ok', metadata: { mcpStructuredContent: mocks.structured } };
    },
  }),
}));

import { MCPToolRegistry } from '../../../../../src/host/mcp/mcpToolRegistry';
import { ensureFailedToolResultError } from '../../../../../src/host/tools/toolResultError';
import { publishEnvAssistToolNotice } from '../../../../../src/host/permissions/envAssist/toolNotice';
import { registerEnvAssistHandlers } from '../../../../../src/host/ipc/envAssist.ipc';
import { ipcHost, type HandlerFn } from '../../../../../src/host/platform';
import type { PassiveBridge, PromptingBridge } from '../../../../../src/host/permissions/envAssist/probes/types';

/** Real mapping: MCPToolRegistry.callExternalTool (SDK result -> ToolResult) then the resolver's ensureFailedToolResultError. */
async function deniedCuaResult(tool: string, text: string): Promise<ToolResult> {
  const client = { callTool: async () => ({ isError: true, content: [{ type: 'text', text }], structuredContent: undefined }) };
  const mapped = await new MCPToolRegistry().callExternalTool('call-1', 'cua-driver', tool, {}, client as never);
  return ensureFailedToolResultError(`mcp__cua-driver__${tool}`, { ...mapped, error: mapped.error }) as ToolResult;
}

async function publish(toolName: string, result: ToolResult, runId = 'r') {
  const events: AgentEvent[] = [];
  await publishEnvAssistToolNotice({ toolName, result, sessionId: 's', runId, onEvent: (e) => events.push(e) });
  return events.filter((e) => e.type === 'env_assist_notice').map((e) => e.data as EnvAssistNotice);
}

beforeEach(() => {
  mocks.messages.length = 0; mocks.calls.length = 0; mocks.status = 'connected';
  mocks.structured = { accessibility: true, screen_recording: false, screen_recording_capturable: false, direct_capture_status: 'unknown', source: 'helper' };
});

describe('cua permission denial -> env_assist_notice', () => {
  it('①a screen-capture denial emits one needs_user notice with a helper target', async () => {
    const result = await deniedCuaResult('get_window_state', 'Screen Recording permission not granted for Agent Neo Computer Use.');
    expect(result.error).toMatch(/without an error message/); // generic backfill: the denial text lives in output
    const notices = await publish('mcp__cua-driver__get_window_state', result);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ phase: 'needs_user', class: 'perm_screen_recording', target: { id: 'helperScreen' }, action: { kind: 'request_grant', payload: { pane: 'screenCapture' } } });
  });
  it('①b an accessibility denial maps to the accessibility pane', async () => {
    mocks.structured = { accessibility: false, screen_recording: true, source: 'helper' };
    const result = await deniedCuaResult('click', 'Accessibility permission not granted.');
    const notices = await publish('mcp__cua-driver__click', result);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ phase: 'needs_user', class: 'perm_accessibility', target: { id: 'helperComputer' }, action: { payload: { pane: 'accessibility' } } });
  });
  it('model-visible error keeps the existing guidance and leaks no raw text', async () => {
    const result = await deniedCuaResult('get_window_state', 'Screen Recording permission not granted for Agent Neo Computer Use.');
    await publish('mcp__cua-driver__get_window_state', result);
    expect(result.error).toContain('Model guidance (not user copy): A permission card has already been shown to the user.');
    expect(result.error).toContain('The card has an allow button.');
    expect(result.error).not.toMatch(/Agent Neo Computer Use|get_window_state|com\.agentneo/);
    expect(result.output).toBeUndefined();
  });
  it('③ probe is the helper identity: check_permissions with prompt:false, never prompt:true', async () => {
    await publish('mcp__cua-driver__get_window_state', await deniedCuaResult('get_window_state', 'Screen Recording permission not granted'));
    expect(mocks.calls).toEqual([{ server: 'cua-driver', tool: 'check_permissions', args: { prompt: false, probe_direct_capture: false } }]);
    expect(mocks.calls.some((c) => c.args.prompt === true)).toBe(false);
  });
  it('probe unavailable still shows the card from the error text; non-permission failures and Neo-own text do not', async () => {
    mocks.status = 'disconnected';
    const notices = await publish('mcp__cua-driver__get_window_state', await deniedCuaResult('get_window_state', 'Screen Recording permission not granted'));
    expect(notices).toHaveLength(1);
    expect(mocks.calls).toHaveLength(0);
    expect(await publish('mcp__cua-driver__click', await deniedCuaResult('click', 'stale element index'))).toHaveLength(0);
    expect(await publish('mcp__cua-driver__click', await deniedCuaResult('click', '另一个会话正在使用计算机'))).toHaveLength(0);
  });
  it('probe says everything is granted -> no stale card', async () => {
    mocks.structured = { accessibility: true, screen_recording: true };
    expect(await publish('mcp__cua-driver__get_window_state', await deniedCuaResult('get_window_state', 'Screen Recording permission denied'))).toHaveLength(0);
  });
});

describe('② act on a cua notice uses the helper bridge only', () => {
  let handler: HandlerFn | undefined;
  const shell = { passive: 0, prompting: 0 };
  const passiveBridge = new Proxy({}, { get: () => async () => { shell.passive++; return true; } }) as unknown as PassiveBridge;
  const grantBridge = new Proxy({}, { get: () => async () => { shell.prompting++; } }) as unknown as PromptingBridge;

  let runSeq = 0;
  async function setup(screenAfterGrant: boolean) {
    shell.passive = 0; shell.prompting = 0;
    vi.spyOn(ipcHost, 'handle').mockImplementation((_c, fn) => { handler = fn; });
    const [notice] = await publish('mcp__cua-driver__get_window_state', await deniedCuaResult('get_window_state', 'Screen Recording permission not granted'), `run-${++runSeq}`);
    const helperGrant = vi.fn(async () => { mocks.structured = { accessibility: true, screen_recording: screenAfterGrant }; });
    const open = vi.fn(async () => true);
    registerEnvAssistHandlers({
      available: () => true, open, findNotice: async (id) => id === notice.id ? notice : undefined,
      passiveBridge, grantBridge, cuaHelperGrantBridge: { requestHelperGrant: helperGrant },
    });
    const act = () => handler!({} as never, { action: 'act', payload: { noticeId: notice.id, actionKind: 'request_grant', payload: { pane: 'screenCapture' } } });
    return { act, helperGrant, open };
  }

  it('granted: one helper call, zero shell calls, re-check reads the helper, second click rejected', async () => {
    const { act, helperGrant, open } = await setup(true);
    mocks.calls.length = 0;
    expect(await act()).toMatchObject({ data: { status: 'checked', outcome: { status: 'granted' } } });
    expect(helperGrant).toHaveBeenCalledTimes(1);
    expect(shell).toEqual({ passive: 0, prompting: 0 });
    expect(mocks.calls.map((c) => c.args)).toEqual([{ prompt: false, probe_direct_capture: false }]);
    expect(open).not.toHaveBeenCalled();
    expect(await act()).toMatchObject({ data: { status: 'rejected' } });
    expect(helperGrant).toHaveBeenCalledTimes(1);
  });
  it('still denied after the one helper action: falls back to the settings pane', async () => {
    const { act, helperGrant, open } = await setup(false);
    expect(await act()).toMatchObject({ data: { status: 'opened', outcome: { status: 'denied' } } });
    expect(helperGrant).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledExactlyOnceWith('screenCapture');
    expect(shell).toEqual({ passive: 0, prompting: 0 });
  });
});
