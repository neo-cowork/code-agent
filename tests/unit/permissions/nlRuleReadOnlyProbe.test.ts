// ============================================================================
// N-PERM-NL-RULES-K2 × 只读探测免卡（ReadOnlyProbePlan）
// ----------------------------------------------------------------------------
// 只读探测在进程内直接执行、不出卡。一句话规则必须先于它生效：带角色范围的
// ask / handback、以及 preapprove 未命中短语（= ask）都要照常出卡，不能被探测
// 悄悄执行掉。真 ToolExecutor + 真 Bash 工具 + 真探测执行器，只 mock 会话消息源。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

/** 设了值 = 会话来自一个定时任务，且该任务被授权读写这个文件夹。 */
const cronGrant = vi.hoisted(() => ({ root: undefined as string | undefined }));
vi.mock('../../../src/host/services/core/databaseService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/core/databaseService')>();
  return { ...actual, getDatabase: () => ({
    getMessages: () => [],
    getSession: () => cronGrant.root ? { origin: { kind: 'cron', id: 'k2-probe-job' } } : null,
    getDb: () => ({ prepare: () => ({
      get: () => cronGrant.root ? { metadata: JSON.stringify({ writeGrantRoot: cronGrant.root }) } : undefined,
      all: () => [],
    }) }),
  }) as unknown as ReturnType<typeof actual.getDatabase> };
});

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { beginRunPolicy, endRunPolicy } from '../../../src/host/permissions/runPolicySnapshot';
import { getDecisionHistory, resetDecisionHistory } from '../../../src/host/security/decisionHistory';
import { getDenialRegistry } from '../../../src/host/security/denialRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';

const SESSION = 'k2-probe-session';
const RUN_ID = 'k2-probe-run';
const ROLE = 'finance';

describe('一句话规则先于只读探测免卡', () => {
  let root: string;
  let asks: Array<{ handback?: boolean }>;

  beforeAll(() => { getProtocolRegistry(); });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'k2-probe-')));
    await fs.writeFile(path.join(root, 'note.txt'), 'hello');
    asks = [];
    cronGrant.root = undefined;
    delete process.env.CODE_AGENT_READONLY_PROBE;
    getToolCache().clear();
    resetPermissionModeManager();
    resetPolicyEngine();
    resetDecisionHistory();
    // 出卡用例里卡被拒会登记「本会话拒过这条命令」；不清掉，下一条用例的同一命令会被直接挡。
    getDenialRegistry().clearAll();
  });

  afterEach(async () => {
    endRunPolicy(RUN_ID);
    resetPolicyEngine();
    resetPermissionModeManager();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  function run(command: string, scheduled = false) {
    const executor = new ToolExecutor({
      requestPermission: async (request) => {
        asks.push({ handback: (request as { handback?: boolean }).handback });
        return false;
      },
      workingDirectory: root,
    });
    executor.setAuditEnabled(false);
    if (scheduled) {
      // 定时任务的 run：无人值守 + 后台拓扑，授权文件夹内的只读命令本来免卡。
      cronGrant.root = root;
      getPermissionModeManager().markUnattendedSession(SESSION);
      executor.setExecutionTopology('async_agent');
    }
    return executor.execute('Bash', { command }, { sessionId: SESSION });
  }
  const probeRows = () => getDecisionHistory().getAll().filter((entry) => entry.reason === 'readonly-probe-plan');
  // 共享解析器读不懂 `command -v`，所以它不走「已知安全命令」捷径，只可能由只读探测放行。
  const LOOKUP = 'command -v exiftool; command -v mdls; command -v sips';

  it('对照：没有规则时这条命令确实走探测、不出卡', async () => {
    beginRunPolicy(RUN_ID, SESSION, { roleId: ROLE, initiatingText: '看看装了哪些工具' });
    const result = await run(LOOKUP);
    expect(result.success).toBe(true);
    expect(result.metadata?.readonlyProbePlan).toBe(true);
    expect(asks).toEqual([]);
  });

  it('带角色范围的 ask：该角色的 run 出卡，探测不执行', async () => {
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'ask', rule: 'Bash(command -v *)', roleId: ROLE }] });
    beginRunPolicy(RUN_ID, SESSION, { roleId: ROLE, initiatingText: '看看装了哪些工具' });
    await run(LOOKUP);
    expect(asks).toHaveLength(1);
    expect(probeRows()).toHaveLength(0);
  });

  it('带角色范围的 ask 只管该角色：别的角色照常走探测', async () => {
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'ask', rule: 'Bash(command -v *)', roleId: ROLE }] });
    beginRunPolicy(RUN_ID, SESSION, { roleId: 'legal', initiatingText: '看看装了哪些工具' });
    const result = await run(LOOKUP);
    expect(result.metadata?.readonlyProbePlan).toBe(true);
    expect(asks).toEqual([]);
  });

  it('带角色范围的 ask 命中后半段命令：同样出卡', async () => {
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'ask', rule: 'Bash(echo *)', roleId: ROLE }] });
    beginRunPolicy(RUN_ID, SESSION, { roleId: ROLE, initiatingText: '看看装了哪些工具' });
    await run(`${LOOKUP}; echo "EXIT_OK"`);
    expect(asks).toHaveLength(1);
    expect(probeRows()).toHaveLength(0);
  });

  it('带角色范围的 handback：出 handback 卡，探测不执行', async () => {
    getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'handback', rule: 'Bash(command -v *)', roleId: ROLE }] });
    beginRunPolicy(RUN_ID, SESSION, { roleId: ROLE, initiatingText: '看看装了哪些工具' });
    await run(LOOKUP);
    expect(asks).toEqual([{ handback: true }]);
    expect(probeRows()).toHaveLength(0);
  });

  // preapprove 走 allow 口径匹配，拆不出词的 `command -v` 不会被它命中；这里换一条 allow 口径
  // 认得、又不在「已知安全命令」里的只读命令。xattr 只有 macOS 有：别的平台探测自己放弃、回审批链。
  const ATTRS = 'xattr -l note.txt';
  const PREAPPROVE = { behavior: 'preapprove' as const, rule: 'Bash(xattr *)', phrases: ['查一下属性'] };

  it('preapprove 未命中短语：出卡，不被探测静默执行', async () => {
    getPolicyEngine().loadUserRules({ nlRules: [PREAPPROVE] });
    beginRunPolicy(RUN_ID, SESSION, { roleId: undefined, initiatingText: '例行检查' });
    await run(ATTRS);
    expect(asks).toHaveLength(1);
    expect(probeRows()).toHaveLength(0);
  });

  it('preapprove 命中短语：不出卡', async () => {
    getPolicyEngine().loadUserRules({ nlRules: [PREAPPROVE] });
    beginRunPolicy(RUN_ID, SESSION, { roleId: undefined, initiatingText: '帮我查一下属性' });
    await run(ATTRS);
    expect(asks).toEqual([]);
  });
  describe('定时任务（已授权文件夹内）', () => {
    const listThenEcho = () => `ls -la "${root}"; echo "done"`;

    it('对照：没有规则时不出卡', async () => {
      beginRunPolicy(RUN_ID, SESSION, { roleId: ROLE, initiatingText: '每日巡检' });
      const result = await run(listThenEcho(), true);
      expect(result.success).toBe(true);
      expect(asks).toEqual([]);
    });

    it('带角色范围的 ask 命中后半段命令：出卡', async () => {
      getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'ask', rule: 'Bash(echo *)', roleId: ROLE }] });
      beginRunPolicy(RUN_ID, SESSION, { roleId: ROLE, initiatingText: '每日巡检' });
      await run(listThenEcho(), true);
      expect(asks).toHaveLength(1);
      expect(probeRows()).toHaveLength(0);
    });

    it('带角色范围的 handback 命中后半段命令：出卡', async () => {
      getPolicyEngine().loadUserRules({ nlRules: [{ behavior: 'handback', rule: 'Bash(echo *)', roleId: ROLE }] });
      beginRunPolicy(RUN_ID, SESSION, { roleId: ROLE, initiatingText: '每日巡检' });
      await run(listThenEcho(), true);
      expect(asks).toHaveLength(1);
      expect(probeRows()).toHaveLength(0);
    });
  });
});
