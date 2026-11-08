// N-FIX-NL-RULE-ASK-BASH-SILENT-ABORT：Bash 被本轮工具面收掉时必须留下可区分日志 + 人话终态，
// 不能是「Bash is disabled」式无原因中断。规则经 loadUserRules 真实装载（translator 同款规则串）。

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info, debug: vi.fn(), warn, error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

import {
  describeDeniedShellCalls,
  redirectDeniedShellCalls,
  summarizeForegroundShellRequest,
} from '../../../src/host/agent/runtime/foregroundShellDenial';
import type { ToolCall } from '../../../src/shared/contract';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { TurnTraceRecorder } from '../../../src/host/agent/runtime/turnTrace';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { buildRuleString } from '../../../src/shared/permissionRuleTranslate';

const ctx = { sessionId: 'fg-shell' } as unknown as RuntimeContext;
const bashCall: ToolCall = {
  id: 'call-bash-1',
  name: 'Bash',
  arguments: { command: 'osascript <<\'EOF\'\nreturn 1\nEOF' },
};

function foregroundContext(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    sessionId: 'fg-shell',
    foregroundToolFace: true,
    allowedToolNames: ['delegate_task'],
    messages: [{ id: 'user-1', role: 'user', content: '明天上午 9 点提醒我交报告。请用 Bash 工具执行多行 osascript（heredoc）建提醒', timestamp: 1 }],
    runId: 'run-1',
    turn: { currentTurnId: 'turn-1', runUserPrompt: '明天上午 9 点提醒我交报告。请用 Bash 工具执行多行 osascript（heredoc）建提醒' },
    turnTrace: new TurnTraceRecorder('fg-shell', '/tmp/fg-shell-trace-unused'),
    ...overrides,
  } as unknown as RuntimeContext;
}

describe('describeDeniedShellCalls', () => {
  beforeAll(() => { getProtocolRegistry(); });
  beforeEach(() => { resetPolicyEngine(); warn.mockClear(); info.mockClear(); });
  afterEach(() => resetPolicyEngine());

  it('Bash 被收出工具面 + 用户有 Bash(rm *) ask 规则：warn 带原因与规则 id，给出人话终态', () => {
    getPolicyEngine().loadUserRules({ ask: [buildRuleString({ tool: 'Bash', pattern: 'rm *' })] }, 'user-ui');
    const out = describeDeniedShellCalls(ctx, [{ name: 'Bash' }]);
    expect(out?.finalMessage).toContain('命令没有运行');
    expect(out?.guidance).toContain('NOT run');
    expect(out?.guidance).not.toMatch(/Bash is disabled/i);
    expect(out?.guidance).not.toContain('spawn_agent');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Bash call dropped before approval'), expect.objectContaining({
      cause: 'tool-not-in-run-toolset',
      userBashRules: ['user-prompt-Bash(rm *)'],
    }));
  });

  it('非 Bash 工具被禁不触发本交代', () => {
    expect(describeDeniedShellCalls(ctx, [{ name: 'AskUserQuestion' }])).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('前台 Bash 调用改写为带完整参数的 delegate_task', () => {
    const out = redirectDeniedShellCalls(foregroundContext(), [bashCall]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: bashCall.id, name: 'delegate_task' });
    expect(out[0].arguments).toEqual({
      title: '明天上午 9 点提醒我交报告',
      short_name: '明天上午',
      lane_key: 'foreground-shell:run-1',
      submission_key: 'foreground-shell:run-1',
      prompt: '明天上午 9 点提醒我交报告。请用 Bash 工具执行多行 osascript（heredoc）建提醒\n\nCommand to run:\nosascript <<\'EOF\'\nreturn 1\nEOF',
    });
    expect(String(out[0].arguments.title)).not.toContain('osascript');
    expect(info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cause: 'foreground-shell-redirected' }));
  });

  it('任务摘要使用用户目标，不把工具名或命令带进标题', () => {
    const summary = summarizeForegroundShellRequest('请用 Bash 运行测试：npm run -s typecheck && npx vitest run tests/unit/app');
    expect(summary).toEqual({ title: '运行测试', shortName: '运行测试', userMessage: '运行测试' });
    expect(summary.title).not.toMatch(/Bash|npm|vitest|typecheck/i);
  });

  it.each([
    ['明天上午 9 点提醒我开会。请用 Bash 执行 osascript 建提醒', '明天上午 9 点提醒我开会'],
    ['用终端把 Downloads 里的 pdf 按日期归档', '把 Downloads 里的 pdf 按日期归档'],
    ['用 Bash 查一下磁盘占用', '查一下磁盘占用'],
  ])('非验收句子的摘要保持用户目标：%s', (prompt, title) => {
    const summary = summarizeForegroundShellRequest(prompt);
    expect(summary.title).toBe(title);
    expect(summary.title).not.toMatch(/Bash|terminal|shell|osascript|heredoc|command|命令行|终端|工具|npm|npx|vitest|typecheck/i);
    expect(summary.title).not.toContain('交报告');
    expect(Array.from(summary.shortName).length).toBeGreaterThanOrEqual(2);
    expect(Array.from(summary.shortName).length).toBeLessThanOrEqual(4);
  });

  it('同一 turn 的多个 Bash 调用共用 submission_key，交给共享委托路径复用', () => {
    const out = redirectDeniedShellCalls(foregroundContext(), [
      bashCall,
      { ...bashCall, id: 'call-bash-2', arguments: { command: 'osascript <<\'EOF\'\nreturn 2\nEOF' } },
    ]);
    expect(out.map((call) => call.name)).toEqual(['delegate_task', 'delegate_task']);
    expect(out.map((call) => call.arguments.submission_key)).toEqual([
      'foreground-shell:run-1',
      'foreground-shell:run-1',
    ]);
    expect(out.map((call) => call.arguments.lane_key)).toEqual([
      'foreground-shell:run-1',
      'foreground-shell:run-1',
    ]);
  });

  it('非前台回合不改写 Bash', () => {
    const out = redirectDeniedShellCalls({ ...foregroundContext(), foregroundToolFace: false }, [bashCall]);
    expect(out).toEqual([bashCall]);
    expect(info).not.toHaveBeenCalled();
  });

  it('delegate_task 被 run policy 禁用时保留旧拒绝路径', () => {
    const out = redirectDeniedShellCalls(foregroundContext({ allowedToolNames: ['AskUserQuestion'] }), [bashCall]);
    expect(out).toEqual([bashCall]);
    const denial = describeDeniedShellCalls(foregroundContext({ allowedToolNames: ['AskUserQuestion'] }), [bashCall]);
    expect(denial?.guidance).toContain('command was NOT run');
    expect(denial?.guidance).not.toContain('spawn_agent');
  });

  it('混合批次只保留 Bash 的后台委托，并把其他调用记为 TOOL_BATCH_SKIPPED', () => {
    const turnTrace = new TurnTraceRecorder('fg-shell', '/tmp/fg-shell-trace-unused');
    const record = vi.spyOn(turnTrace, 'record').mockImplementation(() => undefined);
    const out = redirectDeniedShellCalls(foregroundContext({ turnTrace }), [
      bashCall,
      { id: 'call-connector-1', name: 'reminders_create', arguments: { title: '报告' } },
    ]);
    expect(out.map((call) => call.name)).toEqual(['delegate_task']);
    expect(record).toHaveBeenCalledWith('tool_dispatch', expect.objectContaining({
      toolCallId: 'call-connector-1',
      outcome: 'skipped',
      error: 'TOOL_BATCH_SKIPPED',
    }));
  });
});
