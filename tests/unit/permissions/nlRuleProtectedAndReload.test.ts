// ============================================================================
// N-PERM-NL-RULES-K2 返修（PR #2911 Important 2 + 3）
// ----------------------------------------------------------------------------
// 2. 高危探针（isProtectedAllowRule）此前只在翻译器里跑：settings set / 改配置文件
//    写进 {behavior:'preapprove', rule:'Bash(sudo *)'} 后，发起话带短语的 run 里 sudo
//    免审批执行。修法：探针进 nlRules 的唯一校验函数，保存与装载都过。
// 3. nl 规则 id 不含 phrases：热重载改短语时 id 没变 → 引擎保留旧短语，被删掉的短语
//    照样放行直到重启。修法：phrases 进 id，改短语 = 换一条规则（也吃 run 冻结语义）。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { beginRunPolicy, endRunPolicy } from '../../../src/host/permissions/runPolicySnapshot';
import { resolveUserRuleOutcomeForTool } from '../../../src/host/permissions/userRuleOutcome';
import { isProtectedAllowRule } from '../../../src/host/permissions/permissionRuleDraft';
import {
  assertValidNlPermissionRules,
  validateNlPermissionRuleEntry,
} from '../../../src/shared/permissionRuleSyntax';

const RUN = 'k2-gate-run';
const SESSION = 'k2-gate-session';

beforeEach(() => {
  resetPolicyEngine();
});

afterEach(() => {
  endRunPolicy(RUN);
  resetPolicyEngine();
});

function outcome(command: string, initiatingText: string | undefined) {
  beginRunPolicy(RUN, SESSION, { initiatingText });
  try {
    return resolveUserRuleOutcomeForTool(SESSION, 'Bash', { command });
  } finally {
    endRunPolicy(RUN);
  }
}

describe('Important 2：高危探针在装载口生效（改配置文件/热重载绕不过）', () => {
  it('preapprove 盖到 sudo 的条目不进引擎 → 发起话带短语也不免审批', () => {
    getPolicyEngine().loadUserRules({
      nlRules: [{ behavior: 'preapprove', rule: 'Bash(sudo *)', phrases: ['确认'] }],
    });
    expect(getPolicyEngine().getRules().filter((rule) => rule.id.startsWith('user-nl:'))).toEqual([]);
    expect(outcome('sudo rm -rf /var/log/nginx', '确认一下').kind).not.toBe('preapproved');
  });

  it.each([
    'Bash(sudo *)',
    'Bash(rm -rf *)',
    'Bash(git push *)',
    'Write(/etc/*)',
    'Read(**/.ssh/**)',
  ])('探针集内的规则 %s 作 preapprove/allow 都被校验拒绝，作 ask/handback/deny 照常', (rule) => {
    expect(isProtectedAllowRule(rule)).toBe(true);
    const preapprove = validateNlPermissionRuleEntry({ behavior: 'preapprove', rule, phrases: ['确认'] }, isProtectedAllowRule);
    expect(preapprove.ok).toBe(false);
    expect(!preapprove.ok && preapprove.reason).toContain('protected');
    expect(validateNlPermissionRuleEntry({ behavior: 'allow', rule }, isProtectedAllowRule).ok).toBe(false);
    for (const behavior of ['ask', 'handback', 'deny'] as const) {
      expect(validateNlPermissionRuleEntry({ behavior, rule }, isProtectedAllowRule).ok, behavior).toBe(true);
    }
  });

  it('探针集外的 preapprove 照常装载、短语命中即免询问', () => {
    getPolicyEngine().loadUserRules({
      nlRules: [{ behavior: 'preapprove', rule: 'Bash(npm publish *)', phrases: ['确认'] }],
    });
    expect(outcome('npm publish --tag next', '确认一下')).toEqual({
      kind: 'preapproved', rule: 'Bash(npm publish *)', phrase: '确认',
    });
  });

  it('同一批里高危条目被跳过，不连累其余条目', () => {
    getPolicyEngine().loadUserRules({
      nlRules: [
        { behavior: 'preapprove', rule: 'Bash(sudo *)', phrases: ['确认'] },
        { behavior: 'handback', rule: 'Bash(sudo *)' },
      ],
    });
    expect(outcome('sudo ls', '确认')).toEqual({ kind: 'handback', rule: 'Bash(sudo *)' });
  });

  it('保存口：assertValidNlPermissionRules 对高危 preapprove 抛错', () => {
    expect(() => assertValidNlPermissionRules(
      [{ behavior: 'preapprove', rule: 'Bash(sudo *)', phrases: ['确认'] }],
      undefined,
      isProtectedAllowRule,
    )).toThrow(/protected/);
    expect(() => assertValidNlPermissionRules(
      [{ behavior: 'preapprove', rule: 'Bash(npm publish *)', phrases: ['确认'] }],
      undefined,
      isProtectedAllowRule,
    )).not.toThrow();
  });
});

describe('Important 3：热重载改短语立即生效', () => {
  const rule = 'Bash(npm publish *)';
  const cmd = 'npm publish --tag next';

  it('删掉一个短语后重载 → 含被删短语的发起话不再免审批', () => {
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'preapprove', rule, phrases: ['确认发布', '照常发'] }] });
    expect(outcome(cmd, '确认发布').kind).toBe('preapproved');

    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'preapprove', rule, phrases: ['照常发'] }] });
    expect(outcome(cmd, '确认发布')).toEqual({ kind: 'ask', rule });
    expect(outcome(cmd, '照常发吧').kind).toBe('preapproved');
    // 旧短语那条规则已卸载，引擎里只剩一条
    expect(getPolicyEngine().getRules().filter((r) => r.id.startsWith('user-nl:'))).toHaveLength(1);
  });

  it('换掉全部短语后重载 → 只认新短语', () => {
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'preapprove', rule, phrases: ['旧口令'] }] });
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'preapprove', rule, phrases: ['新口令'] }] });
    expect(outcome(cmd, '旧口令').kind).toBe('ask');
    expect(outcome(cmd, '新口令').kind).toBe('preapproved');
  });

  it('短语顺序/首尾空白不同不算改动（不重装、不留双份）', () => {
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'preapprove', rule, phrases: ['甲乙', '丙丁'] }] });
    const before = getPolicyEngine().getRules().filter((r) => r.id.startsWith('user-nl:')).map((r) => r.id);
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'preapprove', rule, phrases: [' 丙丁', '甲乙 '] }] });
    const after = getPolicyEngine().getRules().filter((r) => r.id.startsWith('user-nl:')).map((r) => r.id);
    expect(after).toEqual(before);
  });

  it('run 进行中：外部来源删短语立即收紧；外部来源加短语对本 run 冻结，下个 run 生效', () => {
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'preapprove', rule, phrases: ['确认发布'] }] });
    beginRunPolicy(RUN, SESSION, { initiatingText: '确认发布，另外悄悄发' });
    expect(resolveUserRuleOutcomeForTool(SESSION, 'Bash', { command: cmd }).kind).toBe('preapproved');

    // 配置文件被改（external）：换成另一个短语——对已开始的 run，旧短语立即失效，
    // 新短语（放宽）冻结到下个 run；本 run 不得因新短语免审批。
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'preapprove', rule, phrases: ['悄悄发'] }] }, 'external');
    expect(resolveUserRuleOutcomeForTool(SESSION, 'Bash', { command: cmd }).kind).not.toBe('preapproved');
    endRunPolicy(RUN);

    expect(outcome(cmd, '悄悄发').kind).toBe('preapproved');
    expect(outcome(cmd, '确认发布').kind).toBe('ask');
  });

  it('run 进行中：用户在设置里改短语（user-ui）立即生效', () => {
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'preapprove', rule, phrases: ['确认发布'] }] }, 'user-ui');
    beginRunPolicy(RUN, SESSION, { initiatingText: '照常发' });
    expect(resolveUserRuleOutcomeForTool(SESSION, 'Bash', { command: cmd })).toEqual({ kind: 'ask', rule });
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'preapprove', rule, phrases: ['照常发'] }] }, 'user-ui');
    expect(resolveUserRuleOutcomeForTool(SESSION, 'Bash', { command: cmd }).kind).toBe('preapproved');
  });
});
