// N-FIX-NL-RULE-ASK-BASH-SILENT-ABORT：Bash 被本轮工具面收掉时必须留下可区分日志 + 人话终态，
// 不能是「Bash is disabled」式无原因中断。规则经 loadUserRules 真实装载（translator 同款规则串）。

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info, debug: vi.fn(), warn, error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

import { describeDeniedShellCalls, redirectDeniedShellCalls } from '../../../src/host/agent/runtime/foregroundShellDenial';
import type { ToolCall } from '../../../src/shared/contract';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
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
    messages: [{ id: 'user-1', role: 'user', content: '明天提醒我交报告', timestamp: 1 }],
    runId: 'run-1',
    turn: { currentTurnId: 'turn-1', runUserPrompt: '明天提醒我交报告' },
    turnTrace: { record: vi.fn() },
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
      title: '后台执行任务',
      short_name: '后台任务',
      lane_key: 'foreground-shell:turn-1',
      submission_key: bashCall.id,
      prompt: '明天提醒我交报告\n\nCommand to run:\nosascript <<\'EOF\'\nreturn 1\nEOF',
    });
    expect(String(out[0].arguments.title)).not.toContain('osascript');
    expect(info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cause: 'foreground-shell-redirected' }));
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
    const turnTrace = { record: vi.fn() };
    const out = redirectDeniedShellCalls(foregroundContext({ turnTrace }), [
      bashCall,
      { id: 'call-connector-1', name: 'reminders_create', arguments: { title: '报告' } },
    ]);
    expect(out.map((call) => call.name)).toEqual(['delegate_task']);
    expect(turnTrace.record).toHaveBeenCalledWith('tool_dispatch', expect.objectContaining({
      toolCallId: 'call-connector-1',
      outcome: 'skipped',
      error: 'TOOL_BATCH_SKIPPED',
    }));
  });
});
