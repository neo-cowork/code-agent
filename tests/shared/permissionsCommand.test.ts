import { describe, expect, it, vi } from 'vitest';
import { formatPermissionsBlock } from '../../src/shared/i18n/permissionsCommand';
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
          timestamp: now, toolName: 'spawn_agent', summary: '', outcome, reason: '已放行', durationMs: 3,
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
    expect(text.replaceAll('已放行', '')).not.toMatch(/[一-鿿]/);
    for (const id of OUTCOMES) expect(text).not.toContain(id);
    expect(text).toContain('Auto-approved');
    expect(text).toContain('Request approval');
    expect(text).toContain('3 ms');
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
