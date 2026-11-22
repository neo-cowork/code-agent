// N-UX-APPROVAL-CARD-REDESIGN-FU1-READONLY-FREE-FU2-FU1：「查询前免确认」开关同样约束前台
// ListDirectory / Glob。全部走公共入口 ToolExecutor.execute + 真 PermissionClassifier。
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigService } from '../../../src/host/services/core/configService';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { resetDecisionHistory } from '../../../src/host/security/decisionHistory';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';

describe('readOnlyProbePlan switch governs ListDirectory / Glob', () => {
  let root: string;
  let asks: Array<{ tool?: string; forceConfirm?: boolean }>;

  beforeAll(() => { getProtocolRegistry(); });
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ro-lookup-')));
    for (const n of ['budget.xlsx', 'a.txt', 'b.txt', 'c.md']) await fs.writeFile(path.join(root, n), n);
    asks = [];
    delete process.env.CODE_AGENT_READONLY_PROBE;
    getToolCache().clear();
    resetPermissionModeManager();
    resetPolicyEngine();
    resetDecisionHistory();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  function setSwitch(on: boolean) {
    const settings = getConfigService().getSettings();
    vi.spyOn(getConfigService(), 'getSettings').mockReturnValue({
      ...settings, permissions: { ...settings.permissions, readOnlyProbePlan: on },
    });
  }
  function executor(): ToolExecutor {
    const ex = new ToolExecutor({
      requestPermission: async (req) => { asks.push(req as { tool?: string; forceConfirm?: boolean }); return false; },
      workingDirectory: root,
    });
    ex.setAuditEnabled(false);
    return ex;
  }

  const cases: Array<[string, () => Record<string, unknown>]> = [
    ['ListDirectory', () => ({ path: root })],
    ['Glob', () => ({ pattern: '*', path: root })],
  ];

  for (const [tool, params] of cases) {
    it(`${tool}: switch off -> one permission request`, async () => {
      setSwitch(false);
      const result = await executor().execute(tool, params(), { sessionId: 'ro-lookup' });
      expect(asks).toHaveLength(1);
      expect(asks[0].tool).toBe(tool);
      // autoApprove[level] 便利放行对 forceConfirm 让路，否则卡在 orchestrator 层被吞
      expect(asks[0].forceConfirm).toBe(true);
      expect(result.success).toBe(false);
    });

    it(`${tool}: switch on -> no request, listing returned`, async () => {
      setSwitch(true);
      const result = await executor().execute(tool, params(), { sessionId: 'ro-lookup' });
      expect(asks).toHaveLength(0);
      expect(result.success).toBe(true);
      expect(String(result.output)).toContain('budget.xlsx');
    });
  }

  it('Read keeps auto-approving with the switch off', async () => {
    setSwitch(false);
    const result = await executor().execute('Read', { file_path: path.join(root, 'a.txt') }, { sessionId: 'ro-lookup' });
    expect(asks).toHaveLength(0);
    expect(result.success).toBe(true);
  });
});
