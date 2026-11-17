// ============================================================================
// N-FIX-CRON-LOCAL-WRITE-EACH-FILE-APPROVAL-GRANT-ON-CARD-FU1-FU1-REALRUN1
// 真跑回放：用户在审批卡授权文件夹后，第二次定时运行里模型（dogfood）实际发出的
// Bash 命令原文（取自 tool_execution_events / pending_approvals，路径改写到临时授权目录），
// 走生产入口 evaluateGuardFabricGate：授权夹内只读 → 不追加 topology 审批并留日志；夹外 → 仍审批。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: vi.fn(() => log), logger: log, default: log,
}));

const cron = vi.hoisted(() => ({ root: undefined as string | undefined }));
vi.mock('../../../../src/host/services/core/databaseService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/services/core/databaseService')>();
  return { ...actual, getDatabase: () => ({
    getSession: () => ({ origin: { kind: 'cron', id: 'morning-plan' } }),
    getDb: () => ({ prepare: () => ({ get: () => ({ metadata: JSON.stringify({ writeGrantRoot: cron.root }) }) }) }),
  }) as unknown as ReturnType<typeof actual.getDatabase> };
});

import { evaluateGuardFabricGate } from '../../../../src/host/tools/guardFabricGate';
import { getProtocolRegistry } from '../../../../src/host/tools/protocolRegistry';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../../src/host/permissions/modes';
import { resetPolicyEngine } from '../../../../src/host/permissions/policyEngine';

const SESSION = 'cron-run-2';
const COVERED = 'schedule_readonly_probe_topology_covered';

describe('cron folder grant: guardFabricGate replay of real run-2 Bash commands', () => {
  let tmp: string;
  let grant: string;
  let outside: string;

  const gate = (command: string) => evaluateGuardFabricGate({
    executionToolName: 'Bash', policyToolName: 'Bash', params: { command },
    topology: 'async_agent', sessionId: SESSION, permissionLevel: 'execute',
  });
  const covered = () => log.info.mock.calls.filter((call) => call[0] === COVERED).length;

  beforeEach(async () => {
    getProtocolRegistry();
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cron-grant-gate-')));
    grant = path.join(tmp, 'Notes', 'morning');
    outside = path.join(tmp, 'Documents');
    await fs.mkdir(grant, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    cron.root = grant;
    resetPolicyEngine();
    resetPermissionModeManager();
    getPermissionModeManager().markUnattendedSession(SESSION);
    log.info.mockClear();
  });

  afterEach(async () => {
    resetPolicyEngine();
    resetPermissionModeManager();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('run-2 ls of the granted folder: no topology ask, covered log emitted', () => {
    const result = gate(`ls -la "${grant}" 2>&1`);
    expect(result.forceApproval).toBeUndefined();
    expect(result.deny).toBeUndefined();
    expect(covered()).toBe(1);
  });

  it('run-3 in-folder ls + exit-status echo: no topology ask, covered log emitted', () => {
    const result = gate(`ls -la "${grant}" 2>&1; echo "--- EXIT:$? ---"`);
    expect(result.forceApproval).toBeUndefined();
    expect(covered()).toBe(1);
  });

  it('run-3 compound that also lists a folder outside the grant: topology ask stays', () => {
    const result = gate(`ls -la "${grant}" 2>&1; echo "--- EXIT:$? ---"; ls -la "${outside}" 2>&1; echo "--- EXIT:$? ---"`);
    expect(result.forceApproval).toBe(true);
    expect(covered()).toBe(0);
  });

  it('plain ls of a folder outside the grant: topology ask stays', () => {
    const result = gate(`ls -la "${outside}"`);
    expect(result.forceApproval).toBe(true);
    expect(covered()).toBe(0);
  });

  it('without a persisted grant the in-folder ls still asks', () => {
    cron.root = undefined;
    const result = gate(`ls -la "${grant}" 2>&1`);
    expect(result.forceApproval).toBe(true);
    expect(covered()).toBe(0);
  });
});
