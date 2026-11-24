// ============================================================================
// GUI 接管披露（N-CUA-HOST-GUI-DISCLOSURE）· 判定表 + 每 run 每应用一次。
//
// 经生产入口 attachGuiTakeoverDisclosures 走判定（不测内部函数）：每个触发形状
// 一条、每个豁免形状一条；cua-driver 形状走真 resolveCuaAppTarget 反查链（mock 的
// 只有驱动 list_apps 这一层）。logCollector.tool 的判定留痕是验收①的路径证明。
// ============================================================================
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { logCollector } from '../../../src/host/mcp/logCollector.js';

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({
    callTool: vi.fn(async () => ({
      success: true,
      output: '✅ Found 1 app(s):\n- Keynote (pid 123) [com.apple.iWork.Keynote]',
      metadata: {
        mcpStructuredContent: {
          apps: [{ pid: 123, name: 'Keynote', bundle_id: 'com.apple.iWork.Keynote' }],
        },
      },
    })),
  }),
}));

import {
  attachGuiTakeoverDisclosures,
  resetGuiTakeoverDisclosureState,
} from '../../../src/host/agent/runtime/guiTakeoverDisclosure';

function makeCtx(): RuntimeContext {
  return { sessionId: 's-disclosure', runId: 'run-1' } as unknown as RuntimeContext;
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args };
}

async function disclosuresFor(ctx: RuntimeContext, calls: ToolCall[]) {
  await attachGuiTakeoverDisclosures(ctx, calls);
  return calls.map((tc) => tc.guiTakeoverDisclosure ?? null);
}

describe('GUI 接管披露 · 触发形状（每形状一条）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('computer_use 带 targetApp：披露 Keynote', async () => {
    const got = await disclosuresFor(makeCtx(), [
      call('c1', 'computer_use', { action: 'click', targetApp: 'Keynote' }),
    ]);
    expect(got[0]).toEqual({ code: 'gui_takeover', app: 'Keynote' });
  });

  it('cua-driver app-grant 工具（click + pid）经反查解析出应用：披露 Keynote', async () => {
    const got = await disclosuresFor(makeCtx(), [
      call('c2', 'mcp__cua-driver__click', { pid: 123, x: 100, y: 200 }),
    ]);
    expect(got[0]).toEqual({ code: 'gui_takeover', app: 'Keynote' });
  });

  it('Bash + System Events 点击/按键（classifyShellDesktopAutomation 命中）：披露进程名', async () => {
    const got = await disclosuresFor(makeCtx(), [
      call('c3', 'Bash', {
        command: `osascript -e 'tell application "System Events" to tell process "Keynote" to keystroke "1"'`,
      }),
    ]);
    expect(got[0]).toEqual({ code: 'gui_takeover', app: 'Keynote' });
  });

  it('Bash 激活应用（tell application "X" to activate）：披露该应用', async () => {
    const got = await disclosuresFor(makeCtx(), [
      call('c4', 'bash', { command: `osascript -e 'tell application "Keynote" to activate'` }),
    ]);
    expect(got[0]).toEqual({ code: 'gui_takeover', app: 'Keynote' });
  });

  it('Bash 编辑打开中的文档（set … of slide）：披露该应用', async () => {
    const got = await disclosuresFor(makeCtx(), [
      call('c5', 'Bash', {
        command: `osascript -e 'tell application "Keynote" to set title text of slide 3 of presentation 1 to "2026 年度经营复盘"'`,
      }),
    ]);
    expect(got[0]).toEqual({ code: 'gui_takeover', app: 'Keynote' });
  });
});

describe('GUI 接管披露 · 豁免形状（每形状一条）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('连接器/普通工具（calendar 连接器、WebSearch）：不披露', async () => {
    const got = await disclosuresFor(makeCtx(), [
      call('e1', 'tmeetMeetingListUpcoming', { days: 7 }),
      call('e2', 'WebSearch', { query: 'keynote applescript' }),
    ]);
    expect(got).toEqual([null, null]);
  });

  it('纯 Apple Events 数据读取（count/get，不驱动界面）：不披露', async () => {
    const got = await disclosuresFor(makeCtx(), [
      call('e3', 'Bash', { command: `osascript -e 'tell application "Notes" to count notes'` }),
      call('e4', 'Bash', { command: `osascript -e 'tell application "Keynote" to get name of document 1'` }),
      // set 变量 = 读进变量，不是编辑文档（set 与 of 之间出现 to）
      call('e5', 'Bash', { command: `osascript -e 'tell application "Keynote" to set docName to name of document 1'` }),
    ]);
    expect(got).toEqual([null, null, null]);
  });

  it('cua-driver metadata 工具（list_apps）：不披露、不反查', async () => {
    const got = await disclosuresFor(makeCtx(), [
      call('e6', 'mcp__cua-driver__list_apps', {}),
    ]);
    expect(got).toEqual([null]);
  });

  it('整桌面坐标注入没点名任何应用：宁可不说，不编应用名', async () => {
    const got = await disclosuresFor(makeCtx(), [
      call('e7', 'Bash', {
        command: `osascript -e 'tell application "System Events" to keystroke "h" using command down'`,
      }),
    ]);
    expect(got).toEqual([null]);
  });
});

describe('GUI 接管披露 · 每 run 每应用一次', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('同应用第二次不重复（大小写/trim 归一），第二个应用再披露一次', async () => {
    const ctx = makeCtx();
    const first = await disclosuresFor(ctx, [
      call('d1', 'computer_use', { action: 'click', targetApp: 'Keynote' }),
    ]);
    const second = await disclosuresFor(ctx, [
      call('d2', 'computer_use', { action: 'type', targetApp: 'keynote' }),
      call('d3', 'computer_use', { action: 'click', targetApp: ' Pages ' }),
    ]);
    expect(first[0]).toEqual({ code: 'gui_takeover', app: 'Keynote' });
    expect(second).toEqual([
      null,
      { code: 'gui_takeover', app: 'Pages' },
    ]);
  });

  it('同批两条同应用调用只挂第一条；run 边界重置后同应用重新披露', async () => {
    const ctx = makeCtx();
    const batch = await disclosuresFor(ctx, [
      call('b1', 'computer_use', { action: 'click', targetApp: 'Keynote' }),
      call('b2', 'computer_use', { action: 'screenshot', targetApp: 'Keynote' }),
    ]);
    expect(batch).toEqual([
      { code: 'gui_takeover', app: 'Keynote' },
      null,
    ]);

    resetGuiTakeoverDisclosureState(ctx);
    const afterReset = await disclosuresFor(ctx, [
      call('b3', 'computer_use', { action: 'click', targetApp: 'Keynote' }),
    ]);
    expect(afterReset).toEqual([{ code: 'gui_takeover', app: 'Keynote' }]);
  });

  it('判定留痕：logCollector.tool 记下披露决定（验收①路径证明）', async () => {
    const toolSpy = vi.spyOn(logCollector, 'tool');
    const ctx = makeCtx();
    await attachGuiTakeoverDisclosures(ctx, [
      call('log-1', 'computer_use', { action: 'click', targetApp: 'Keynote' }),
    ]);
    expect(toolSpy).toHaveBeenCalledWith(
      'INFO',
      'GUI takeover disclosure attached (Keynote)',
      expect.objectContaining({ toolCallId: 'log-1', toolName: 'computer_use', appKey: 'name:keynote' }),
    );
    toolSpy.mockRestore();
  });
});

describe('GUI 接管披露 · unresolved 留痕，metadata / 整桌面读取保持安静', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('launch_app 没有 name/bundle_id：一条带 resolver reason 的 WARN，不挂披露，也不打抛错那条', async () => {
    const toolSpy = vi.spyOn(logCollector, 'tool');
    const calls = [
      call('u1', 'mcp__cua-driver__launch_app', {}),
      call('m1', 'mcp__cua-driver__list_apps', {}),
      call('s1', 'mcp__cua-driver__screenshot', { window_id: 77 }),
      call('d1', 'mcp__cua-driver__get_desktop_state', {}),
      call('o1', 'computer_use', { action: 'observe' }),
    ];
    await attachGuiTakeoverDisclosures(makeCtx(), calls);
    expect(calls.map((item) => item.guiTakeoverDisclosure ?? null)).toEqual([null, null, null, null, null]);
    const warns = toolSpy.mock.calls.filter((entry) => entry[0] === 'WARN');
    expect(warns).toEqual([[
      'WARN',
      'GUI takeover disclosure unresolved (tool runs without disclosure)',
      expect.objectContaining({
        toolCallId: 'u1',
        toolName: 'mcp__cua-driver__launch_app',
        reason: expect.stringContaining('neither bundle_id nor name'),
      }),
    ]]);
    expect(toolSpy.mock.calls.some((entry) => String(entry[1]).includes('resolution failed'))).toBe(false);
    toolSpy.mockRestore();
  });

  it('pid 反查失败：WARN 带上 resolver reason，调用本身不被披露层拦住', async () => {
    const toolSpy = vi.spyOn(logCollector, 'tool');
    const calls = [call('u2', 'mcp__cua-driver__get_window_state', { pid: 999 })];
    await expect(attachGuiTakeoverDisclosures(makeCtx(), calls)).resolves.toBeUndefined();
    expect(calls[0]?.guiTakeoverDisclosure).toBeUndefined();
    const warns = toolSpy.mock.calls.filter((entry) => entry[0] === 'WARN');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.[2]).toEqual(expect.objectContaining({
      toolCallId: 'u2',
      toolName: 'mcp__cua-driver__get_window_state',
      reason: expect.stringContaining('pid 999'),
    }));
    toolSpy.mockRestore();
  });
});

describe('GUI 接管披露 · 命中已有键时不把另一应用名并进集合', () => {
  it('已披露 Calculator(bundle) 后，带同 bundle 的 Notes 调用被跳过但不吞掉 Notes：随后只带名字的 Notes 仍披露', async () => {
    const ctx = makeCtx();
    const got = await disclosuresFor(ctx, [
      call('k1', 'computer_use', { action: 'open_application', targetApp: 'Calculator', bundleId: 'com.apple.calculator' }),
      call('k2', 'computer_use', { action: 'click', targetApp: 'Notes', bundleId: 'com.apple.calculator' }),
      call('k3', 'computer_use', { action: 'click', targetApp: 'Notes' }),
    ]);
    expect(got[0]).toEqual({ code: 'gui_takeover', app: 'Calculator' });
    expect(got[1]).toBeNull();
    expect(got[2]).toEqual({ code: 'gui_takeover', app: 'Notes' });
  });

  it('先按名字披露、再带 bundle 的同名调用：并到同一次预告，之后 bundle-only 不再披露', async () => {
    const ctx = makeCtx();
    const got = await disclosuresFor(ctx, [
      call('n1', 'computer_use', { action: 'click', targetApp: 'Calculator' }),
      call('n2', 'computer_use', { action: 'click', targetApp: 'Calculator', bundleId: 'com.apple.calculator' }),
      call('n3', 'computer_use', { action: 'click', targetApp: 'calculator ', bundleId: 'com.apple.calculator' }),
    ]);
    expect(got).toEqual([{ code: 'gui_takeover', app: 'Calculator' }, null, null]);
  });
});
