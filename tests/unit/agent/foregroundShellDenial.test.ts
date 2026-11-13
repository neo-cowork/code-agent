// N-FIX-NL-RULE-ASK-BASH-SILENT-ABORT：Bash 被本轮工具面收掉时必须留下可区分日志 + 人话终态，
// 不能是「Bash is disabled」式无原因中断。规则经 loadUserRules 真实装载（translator 同款规则串）。

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());
const uiState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));
vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ ui: { language: uiState.language } }) }),
}));

import { describeDeniedShellCalls } from '../../../src/host/agent/runtime/foregroundShellDenial';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { buildRuleString } from '../../../src/shared/permissionRuleTranslate';

const ctx = { sessionId: 'fg-shell' } as unknown as RuntimeContext;
const CJK_OR_FULLWIDTH = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/;
const EXPECTED_ZH_FINAL_MESSAGE =
  '本轮前台不直接执行 Shell 命令（Bash），命令没有运行。可以让我把它交给后台代理执行，届时会按你的权限规则询问你。';

function buildTurnCtx(runUserPrompt?: string): RuntimeContext {
  const turn = new TurnState();
  turn.beginRun(runUserPrompt);
  return { sessionId: 'fg-shell', turn } as unknown as RuntimeContext;
}

describe('describeDeniedShellCalls', () => {
  beforeAll(() => { getProtocolRegistry(); });
  beforeEach(() => {
    resetPolicyEngine();
    warn.mockClear();
    uiState.language = 'zh';
  });
  afterEach(() => resetPolicyEngine());

  it('Bash 被收出工具面 + 用户有 Bash(rm *) ask 规则：warn 带原因与规则 id，给出人话终态', () => {
    getPolicyEngine().loadUserRules({ ask: [buildRuleString({ tool: 'Bash', pattern: 'rm *' })] }, 'user-ui');
    const out = describeDeniedShellCalls(ctx, [{ name: 'Bash' }]);
    expect(out?.finalMessage).toContain('命令没有运行');
    expect(out?.guidance).toContain('NOT run');
    expect(out?.guidance).not.toMatch(/Bash is disabled/i);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Bash call dropped before approval'), expect.objectContaining({
      cause: 'tool-not-in-run-toolset',
      userBashRules: ['user-prompt-Bash(rm *)'],
    }));
  });

  it('English turn returns an English finalMessage with no CJK characters and language guidance', () => {
    uiState.language = 'zh';
    const out = describeDeniedShellCalls(
      buildTurnCtx("Please delete ~/Desktop/neo-old-notes.txt, I don't need it any more."),
      [{ name: 'Bash' }],
    );
    expect(out?.finalMessage).toBeDefined();
    expect(out?.finalMessage).not.toMatch(CJK_OR_FULLWIDTH);
    expect(out?.finalMessage).toMatch(/did not run/i);
    expect(out?.finalMessage).toMatch(/background task/i);
    expect(out?.guidance).toContain('Reply in the same language the user is writing in this turn.');
  });

  it('Chinese turn keeps the exact Chinese finalMessage unchanged even when UI language is English', () => {
    uiState.language = 'en';
    const out = describeDeniedShellCalls(
      buildTurnCtx('请把桌面上的 neo-old-notes.txt 删掉，已经不需要了。'),
      [{ name: 'Bash' }],
    );
    expect(out?.finalMessage).toBe(EXPECTED_ZH_FINAL_MESSAGE);
    expect(out?.guidance).toContain('Reply in the same language the user is writing in this turn.');
  });

  it('empty or language-neutral prompt falls back to the UI language', () => {
    uiState.language = 'en';
    const enEmpty = describeDeniedShellCalls(buildTurnCtx(''), [{ name: 'Bash' }]);
    const enNeutral = describeDeniedShellCalls(buildTurnCtx('12345 ???'), [{ name: 'Bash' }]);
    expect(enEmpty?.finalMessage).toBeDefined();
    expect(enEmpty?.finalMessage).not.toMatch(CJK_OR_FULLWIDTH);
    expect(enNeutral?.finalMessage).toBe(enEmpty?.finalMessage);

    uiState.language = 'zh';
    const zhNeutral = describeDeniedShellCalls(buildTurnCtx('12345 ???'), [{ name: 'Bash' }]);
    expect(zhNeutral?.finalMessage).toBe(EXPECTED_ZH_FINAL_MESSAGE);
  });

  it('非 Bash 工具被禁不触发本交代', () => {
    expect(describeDeniedShellCalls(ctx, [{ name: 'AskUserQuestion' }])).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
