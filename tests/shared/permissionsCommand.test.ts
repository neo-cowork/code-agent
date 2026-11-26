import { describe, expect, it, vi } from 'vitest';
import { formatPermissionsBlock } from '../../src/shared/i18n/permissionsCommand';
import { formatPermissionDecision } from '../../src/shared/commands/formatPermissionDecision';
import { permissionsCommand } from '../../src/shared/commands/definitions/newCommands';
import { permissionVocabularyEn, permissionVocabularyZh } from '../../src/renderer/i18n/permissionVocabulary';
import type { CommandContext } from '../../src/shared/commands/types';

const OUTCOMES = ['auto-approve', 'ask-approved', 'ask-denied', 'policy-allow', 'policy-deny', 'classifier-deny', 'hook-blocked', 'monitor-blocked'];
const RULE_PATTERNS = ['npm install', 'git status'];

function stripAllowed(text: string): string {
  let out = text;
  for (const p of RULE_PATTERNS) out = out.split(p).join('');
  return out;
}

async function runCli(language: 'zh' | 'en', mode: string): Promise<string> {
  const lines: string[] = [];
  const now = Date.now();
  const ctx = {
    surface: 'cli',
    getLocale: () => language,
    output: { info: (m: string) => lines.push(m), success: vi.fn(), error: vi.fn(), warn: vi.fn() },
    loadPermissionModes: async () => ({ getPermissionModeManager: () => ({ getMode: () => mode }) }),
    loadExecPolicy: async () => ({
      getExecPolicyStore: () => ({
        getRules: () => [
          { pattern: ['npm', 'install'], decision: 'allow', source: 'user', createdAt: now - 7_200_000 },
          { pattern: ['git', 'status'], decision: 'forbidden', source: 'builtin', createdAt: 1 },
        ],
      }),
    }),
    loadDecisionHistory: async () => ({
      getDecisionHistory: () => ({
        getRecent: () => OUTCOMES.map((outcome) => ({
          timestamp: now, toolName: 'spawn_agent', summary: '', outcome, reason: 'safe-command', durationMs: 3,
          decisionTrace: { finalOutcome: outcome, steps: [1, 2] },
        })),
        getAll: () => OUTCOMES,
      }),
    }),
  } as unknown as CommandContext;
  await permissionsCommand.handler(ctx, []);
  return lines.join('\n');
}

describe('/permissions 诊断块跟随界面语言', () => {
  it.each(['default', 'readOnly', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'plan', 'delegate'])('zh CLI 档位 %s 整块无英文单词', async (mode) => {
    const text = await runCli('zh', mode);
    // 时间戳是数字；去掉规则前缀（用户命令）后不应再有 2 个以上的连续字母
    const residue = stripAllowed(text).match(/[A-Za-z]{2,}/g);
    expect(residue).toBeNull();
    for (const id of [...OUTCOMES, 'default', 'Mode', 'trace=']) expect(text).not.toContain(id);
    expect(text).toContain('自动放行');
    expect(text).toContain('3 毫秒');
  });

  it('en CLI 整块为英文，无中文，无内部 id', async () => {
    const text = await runCli('en', 'default');
    expect(text).not.toMatch(/[一-鿿]/);
    for (const id of OUTCOMES) expect(text).not.toContain(id);
    expect(text).toContain('Auto-approved');
    expect(text).toContain('Request approval');
    expect(text).toContain('3 ms');
  });

  it('zh 决定行：safe-command 译成中文，未登记的英文 reason 不原样露出', () => {
    const line = formatPermissionDecision({ toolName: 'Bash', summary: 'ls -la', outcome: 'auto-approve', reason: 'safe-command', durationMs: 8 }, 'zh');
    expect(line).toBe('运行命令(ls -la) → 自动放行  （安全命令，8 毫秒）');
    expect(line.replace('ls -la', '')).not.toMatch(/[A-Za-z]{2,}/);
    const unknown = formatPermissionDecision({ toolName: 'Bash', summary: 'ls', outcome: 'policy-deny', reason: 'some_new_internal_code', durationMs: 1 }, 'zh');
    expect(unknown).not.toContain('some_new_internal_code');
    expect(formatPermissionDecision({ toolName: 'Bash', summary: 'ls', outcome: 'policy-deny', reason: 'some_new_internal_code', durationMs: 1 }, 'en')).not.toContain('some_new_internal_code');
  });

  it('决定摘要不露绝对家目录，也不在引号中间截断', () => {
    const summary = 'ls -la "/Users/someone/projects/weekly/some folder"';
    for (const language of ['zh', 'en'] as const) {
      const line = formatPermissionDecision({ toolName: 'Bash', summary, outcome: 'auto-approve', reason: 'safe-command', durationMs: 8 }, language);
      expect(line).not.toContain('/Users/someone');
      expect(line).not.toContain('someone');
      expect((line.match(/"/g) ?? []).length % 2).toBe(0);
    }
  });

  it('引号内的命令超长时不被整段丢掉，引号补全', () => {
    const line = formatPermissionDecision({ toolName: 'Bash', summary: "bash -lc 'rm -rf /var/very/long/directory/name/that/keeps/going'", outcome: 'policy-deny', reason: 'exec-policy', durationMs: 1 }, 'en');
    expect(line).toContain("bash -lc 'rm -rf");
    expect(line).toContain("…'");
  });

  it('检查轨迹区分放行与拒绝，不落到「已处理」', () => {
    const base = { toolName: 'Bash', summary: 'ls', outcome: 'auto-approve', reason: 'safe-command', durationMs: 1 };
    expect(formatPermissionDecision(base, 'zh', { finalOutcome: 'allow', steps: 2 })).toContain('检查轨迹 放行/2');
    expect(formatPermissionDecision(base, 'zh', { finalOutcome: 'deny', steps: 1 })).toContain('检查轨迹 拒绝/1');
    expect(formatPermissionDecision(base, 'en', { finalOutcome: 'deny', steps: 1 })).toContain('checks denied/1');
    expect(formatPermissionDecision(base, 'en', { finalOutcome: 'allow', steps: 1 })).not.toContain('Handled');
  });

  it('未知的结果词不露原始 id', () => {
    const lines = formatPermissionsBlock('zh', { mode: 'weird', rules: [], decisions: { total: 1, lines: [] } });
    expect(lines.join('\n')).toContain('未知');
  });

  it('档位词与底栏 permissionVocabulary 同步', () => {
    const modes: Array<[string, keyof typeof permissionVocabularyZh]> = [
      ['default', 'ask'], ['readOnly', 'readOnly'], ['acceptEdits', 'autoApprove'], ['bypassPermissions', 'fullAccess'],
    ];
    for (const [mode, key] of modes) {
      expect(formatPermissionsBlock('zh', { mode, rules: null, decisions: null })[1]).toContain(permissionVocabularyZh[key]);
      expect(formatPermissionsBlock('en', { mode, rules: null, decisions: null })[1]).toContain(permissionVocabularyEn[key]);
    }
  });
});
