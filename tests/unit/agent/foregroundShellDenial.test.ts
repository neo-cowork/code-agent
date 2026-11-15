// N-FIX-NL-RULE-ASK-BASH-SILENT-ABORT：Bash 被本轮工具面收掉时必须留下可区分日志，
// 不能是「Bash is disabled」式无原因中断。规则经 loadUserRules 真实装载（translator 同款规则串）。
// 用户看到的终态那句话经 MessageProcessor.handleToolResponse 验，见 messageProcessor.declareDeliverables.test.ts。

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

import { wrapWithTurnSystemContext } from '../../../src/shared/utils/turnScaffold';
import { getInabilityReplyGuidance, INABILITY_REPLY_CONTRACT } from '../../../src/shared/inabilityReplyContract';
import { describeDeniedShellCalls } from '../../../src/host/agent/runtime/foregroundShellDenial';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { buildRuleString } from '../../../src/shared/permissionRuleTranslate';

const ctx = { sessionId: 'fg-shell' } as unknown as RuntimeContext;
const CJK_OR_FULLWIDTH = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/;
const EXPECTED_ZH_FINAL_MESSAGE =
  '命令没有运行，相关内容没有改动。我可以先帮你查看要处理的内容，或交给后台任务，操作前会先问你。';

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

  it('Bash 被收出工具面 + 用户有 Bash(rm *) ask 规则：warn 带原因与规则 id，指引不说工具被禁用', () => {
    getPolicyEngine().loadUserRules({ ask: [buildRuleString({ tool: 'Bash', pattern: 'rm *' })] }, 'user-ui');
    const out = describeDeniedShellCalls(ctx, [{ name: 'Bash' }]);
    expect(out?.finalMessage).toContain('命令没有运行');
    expect(out?.guidance).toContain('该动作没有执行');
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
    expect(out?.guidance).toContain('Reply in the same language the user is writing in.');
  });

  it('Chinese turn keeps the exact Chinese finalMessage unchanged even when UI language is English', () => {
    uiState.language = 'en';
    const out = describeDeniedShellCalls(
      buildTurnCtx('请把桌面上的 neo-old-notes.txt 删掉，已经不需要了。'),
      [{ name: 'Bash' }],
    );
    expect(out?.finalMessage).toBe(EXPECTED_ZH_FINAL_MESSAGE);
    expect(out?.guidance).toContain('用中文回复。');
  });

  it('Chinese shell requests with ASCII paths or commands stay Chinese instead of flipping to English', () => {
    for (const ui of ['zh', 'en'] as const) {
      uiState.language = ui;
      for (const prompt of [
        '请把 ~/Desktop/neo-old-notes.txt 删掉',
        '请把~/Desktop/neo-old-notes.txt删掉',
        '帮我运行 npm run build',
        '运行 npm install express typescript vitest',
        '看下 src/host/agent/runtime/foregroundShellDenial.ts',
      ]) {
        const out = describeDeniedShellCalls(buildTurnCtx(prompt), [{ name: 'Bash' }]);
        expect(out?.finalMessage, `ui=${ui} prompt=${prompt}`).toBe(EXPECTED_ZH_FINAL_MESSAGE);
      }
    }
  });

  it('English shell requests with CJK filenames still return the English finalMessage', () => {
    uiState.language = 'zh';
    for (const prompt of [
      "Please delete ~/Desktop/会议纪要-2026年11月最终版.docx, I don't need it any more.",
      'Delete 会议纪要-2026年11月最终版.docx',
    ]) {
      const out = describeDeniedShellCalls(buildTurnCtx(prompt), [{ name: 'Bash' }]);
      expect(out?.finalMessage, prompt).toBeDefined();
      expect(out?.finalMessage, prompt).not.toMatch(CJK_OR_FULLWIDTH);
      expect(out?.finalMessage, prompt).toMatch(/did not run/i);
    }
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

  it('model-visible and user-visible denial strings carry none of the internal-mechanism tokens', () => {
    const BANNED = /被禁用|本轮|这一轮|本次运行|disabled for this|tool face|bash|shell/i;
    for (const prompt of ['帮我把 .tmp 临时文件删掉', 'Please delete my tmp files']) {
      const out = describeDeniedShellCalls(buildTurnCtx(prompt), [{ name: 'Bash' }]);
      expect(out?.guidance).not.toMatch(BANNED);
      expect(out?.finalMessage).not.toMatch(BANNED);
      expect(out?.guidance).toContain(prompt.startsWith('Please') ? 'NOT run' : '该动作没有执行');
      expect(out?.guidance).toContain(prompt.startsWith('Please') ? 'background task' : '后台任务');
      expect(out?.guidance).not.toContain('spawn_agent');
      expect(out?.guidance).toBe(getInabilityReplyGuidance(prompt));
      expect(out?.finalMessage).not.toMatch(/权限|拦下|不允许|终端|blocked|not allowed|permission|terminal/i);
    }
  });

  it('English request inside Chinese system scaffolding keeps the English final message', () => {
    const prompt = wrapWithTurnSystemContext(['本轮未收到任何上传附件。只查看当前任务文件夹，不要搜索其他位置。'],
      'Please compress the notes folder into notes-backup.zip in the current directory.');
    const out = describeDeniedShellCalls(buildTurnCtx(prompt), [{ name: 'Bash' }]);
    expect(out?.finalMessage).toBe(INABILITY_REPLY_CONTRACT.en.finalMessage);
    expect(out?.finalMessage).not.toMatch(CJK_OR_FULLWIDTH);
  });

  it('非 Bash 工具被禁不触发本交代', () => {
    expect(describeDeniedShellCalls(ctx, [{ name: 'AskUserQuestion' }])).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
