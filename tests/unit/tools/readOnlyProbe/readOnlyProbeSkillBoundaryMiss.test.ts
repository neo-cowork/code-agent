// 技能 allowed-tools 边界挡下 2b 时：仍出卡（不改决策），但必须留 readonly_probe_plan_miss 且 cause 点名边界变量。
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

const infoCalls = vi.hoisted(() => [] as Array<[string, Record<string, unknown>?]>);
vi.mock('../../../../src/host/services/infra/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/services/infra/logger')>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const real = actual.createLogger(name);
      return new Proxy(real, {
        get: (target, prop, receiver) => prop === 'info'
          ? (msg: string, meta?: Record<string, unknown>) => { infoCalls.push([msg, meta]); }
          : Reflect.get(target, prop, receiver),
      });
    },
  };
});

import { getToolCache } from '../../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../../src/host/tools/protocolRegistry';
import { resetPermissionModeManager } from '../../../../src/host/permissions/modes';
import { resetPolicyEngine } from '../../../../src/host/permissions/policyEngine';
import { getDecisionHistory, resetDecisionHistory } from '../../../../src/host/security/decisionHistory';
import { ToolExecutor } from '../../../../src/host/tools/toolExecutor';

const PROBE = 'command -v pdftotext; command -v pdfinfo; command -v mutool; command -v gs; command -v qpdf; command -v python3; command -v node';

describe('技能边界挡下只读探测：仍出卡 + miss 留痕', () => {
  let root: string;
  let asks: string[];
  beforeAll(() => { getProtocolRegistry(); });
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ro-probe-skill-')));
    asks = [];
    infoCalls.length = 0;
    getToolCache().clear();
    resetPermissionModeManager();
    resetPolicyEngine();
    resetDecisionHistory();
  });
  afterEach(async () => {
    resetPolicyEngine();
    resetPermissionModeManager();
    await fs.rm(root, { recursive: true, force: true });
  });

  for (const command of [PROBE, 'ls -la']) {
    it(`boundary excludes Bash: "${command.slice(0, 24)}" still carded, miss cause names boundaryViolation`, async () => {
      const ex = new ToolExecutor({
        requestPermission: async (req) => { asks.push(String((req as { details?: { command?: string } }).details?.command ?? 'ask')); return false; },
        workingDirectory: root,
      });
      ex.setAuditEnabled(false);
      await ex.execute('Bash', { command }, {
        sessionId: 'ro-probe-skill-session',
        skillToolBoundary: { skillName: 'task-brief-builder', allowedTools: ['Read', 'Glob', 'Grep', 'AskUserQuestion', 'TaskManager'] },
      } as never);
      expect(asks).toHaveLength(1);
      expect(getDecisionHistory().getAll().filter((e) => e.reason === 'readonly-probe-plan')).toEqual([]);
      const miss = infoCalls.filter(([m]) => m === 'readonly_probe_plan_miss');
      expect(miss).toHaveLength(1);
      expect(miss[0][1]).toMatchObject({ cause: 'gate:boundaryViolation', skillName: 'task-brief-builder' });
    });
  }
});
