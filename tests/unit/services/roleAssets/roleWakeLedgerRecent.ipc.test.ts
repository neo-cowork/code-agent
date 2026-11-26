import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IPCRequest, IPCResponse } from '../../../../src/shared/ipc';
import { registerRolesHandlers } from '../../../../src/host/ipc/roles.ipc';
import { getRoleWakeLedgerPath } from '../../../../src/host/services/roleAssets/roleAssetPaths';
import { recordWakeDecision } from '../../../../src/host/services/roleAssets/roleWakeLedger';

const previousDataDir = process.env.CODE_AGENT_DATA_DIR;
let dataDir = '';
let handler: ((event: unknown, request: IPCRequest) => Promise<IPCResponse>) | undefined;

beforeAll(() => {
  registerRolesHandlers({
    handle: (_channel: string, fn: (event: unknown, request: IPCRequest) => Promise<IPCResponse>) => {
      handler = fn;
    },
  } as never);
});

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'wake-ledger-recent-'));
  process.env.CODE_AGENT_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
  else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

describe('roles IPC wakeLedgerRecent', () => {
  it('reads a ledger written by recordWakeDecision and counts new mail and calendar items', async () => {
    const roleId = '晨巡秘书';
    await mkdir(path.dirname(getRoleWakeLedgerPath(roleId)), { recursive: true });
    const t0 = 1_700_000_000_000;
    const t1 = t0 + 60_000;
    const t2 = t1 + 60_000;
    const t3 = t2 + 60_000;
    const report = (at: number, basis: string, rationale: string) => recordWakeDecision(roleId, 'cadence', undefined, at, {
      decision: 'report',
      rationale,
      finalOutput: `<decision>report</decision><rationale>${rationale}</rationale><basis>${basis}</basis>`,
    });
    expect(await report(t0, 'mail:11,calendar:evt-a', '今早有一封旧邮件。')).toBe('report');
    expect(await report(t1, 'mail:11,mail:12,mail:13,calendar:evt-a,calendar:evt-b', '今早有两封新邮件。')).toBe('report');
    expect(await report(t2, 'mail:11,mail:12,mail:13,calendar:evt-a,calendar:evt-b', '还是那两封邮件。')).toBe('silence');
    expect(await recordWakeDecision(roleId, 'cadence', undefined, t3, {
      decision: 'silence',
      silenceReason: 'no_products',
    })).toBe('silence');

    const raw = await readFile(getRoleWakeLedgerPath(roleId), 'utf8');
    expect(raw).toContain('"decision":"suppressed_duplicate"');
    const response = await handler!(null, { action: 'wakeLedgerRecent', payload: { roleId } } as IPCRequest);
    expect(response.success).toBe(true);
    const body = JSON.stringify(response.data);
    expect(body).not.toContain('mail:');
    expect(body).not.toContain('calendar:');
    expect(body).not.toContain('evt-a');
    expect(response.data).toEqual([
      {
        at: t0,
        decision: 'report',
        reason: '今早有一封旧邮件。',
        newBasis: { mail: 0, calendar: 0 },
      },
      {
        at: t1,
        decision: 'report',
        reason: '今早有两封新邮件。',
        newBasis: { mail: 2, calendar: 1 },
      },
      {
        at: t2,
        decision: 'suppressed_duplicate',
        reason: 'previously_reported',
        newBasis: { mail: 0, calendar: 0 },
        firstReportedAt: t0,
      },
      {
        at: t3,
        decision: 'silent',
        reason: 'no_products',
        newBasis: { mail: 0, calendar: 0 },
      },
    ]);
  });

  it('rejects an unsafe role id', async () => {
    const response = await handler!(null, { action: 'wakeLedgerRecent', payload: { roleId: '../secret' } } as IPCRequest);
    expect(response).toEqual({ success: false, error: { code: 'INVALID_ARGS', message: 'a safe roleId is required' } });
  });
});
