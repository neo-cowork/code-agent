// ============================================================================
// N-PERM-NL-RULES-K2 返修 r6（同类位置）：nlRules 的 deny 路径规则在 shell 写路径口也要硬拒
// ----------------------------------------------------------------------------
// 带角色范围的「永不」规则落 permissions.nlRules（id 前缀 user-nl:deny:）。直接调
// Write/Edit 时 guardFabricGate 认它；但 shell 写目标（echo > path）走的是
// denyConcreteShellWritePath → matchUserPathDeny，那里只认旧表前缀 user-deny-，
// 于是同一条规则换成 Bash 重定向就绕过去了。与审查指出的高危探针是同一类问题：
// 一道门只装在一个入口上。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { beginRunPolicy, endRunPolicy } from '../../../src/host/permissions/runPolicySnapshot';
import { denyConcreteShellWritePath } from '../../../src/host/tools/shell/writePathPolicyDeny';

const RUN = 'k2-path-sink-run';
const SESSION = 'k2-path-sink-session';
const TARGET = '/tmp/k2-contracts/2026/final.docx';

function shellWriteVerdict(sessionId?: string) {
  return denyConcreteShellWritePath({
    resolvedPath: TARGET,
    workingDirectory: '/tmp/k2-workspace',
    policyEnforcer: null,
    sessionId,
  });
}

beforeEach(() => {
  resetPolicyEngine();
});

afterEach(() => {
  endRunPolicy(RUN);
  resetPolicyEngine();
});

describe('shell 写路径口认 nlRules 的 deny', () => {
  it('对照：旧表 deny 的路径规则本来就硬拒', () => {
    getPolicyEngine().loadUserRules({ deny: ['Write(/tmp/k2-contracts/**)'] });
    expect(shellWriteVerdict()?.allowed).toBe(false);
  });

  it('全局 nlRules deny 的路径规则 → shell 写目标同样硬拒', () => {
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'deny', rule: 'Write(/tmp/k2-contracts/**)' }] });
    const verdict = shellWriteVerdict();
    expect(verdict?.allowed).toBe(false);
    expect(verdict?.section).toBe('user-permissions');
  });

  it('带角色范围的 deny：该角色的 run 里硬拒，别的角色与主聊天不受影响', () => {
    getPolicyEngine().loadUserRules({
      nlRules: [{ behavior: 'deny', rule: 'Write(/tmp/k2-contracts/**)', roleId: 'legal-clerk' }],
    });
    beginRunPolicy(RUN, SESSION, { roleId: 'legal-clerk' });
    expect(shellWriteVerdict(SESSION)?.allowed).toBe(false);
    endRunPolicy(RUN);

    beginRunPolicy(RUN, SESSION, { roleId: 'ops-editor' });
    expect(shellWriteVerdict(SESSION)).toBeUndefined();
    endRunPolicy(RUN);

    expect(shellWriteVerdict(SESSION)).toBeUndefined();
  });

  it('nlRules 的 handback/ask 路径规则不在这里硬拒（它们走审批链）', () => {
    getPolicyEngine().loadUserRules({
      nlRules: [
        { behavior: 'handback', rule: 'Write(/tmp/k2-contracts/**)' },
        { behavior: 'ask', rule: 'Edit(/tmp/k2-contracts/**)' },
      ],
    });
    expect(shellWriteVerdict()).toBeUndefined();
  });
});
