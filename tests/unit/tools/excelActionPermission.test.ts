import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyPermission, getPermissionClassifier } from '../../../src/host/tools/permissionClassifier';
import { resolveToolPermissionClassification } from '../../../src/host/tools/toolPermissionClassification';
import { resolveExcelWriteTargets } from '../../../src/host/tools/modules/excel/resolveExcelWriteTargets';
import { resolveToolWriteTargets } from '../../../src/host/tools/writeTargets';
import { excelAutomateSchema } from '../../../src/host/tools/modules/excel/excelAutomate.schema';
import { mustAskUnderAcceptEdits } from '../../../src/host/tools/externalSideEffect';
import type { PermissionMode } from '../../../src/host/permissions/modes';
import { EXCEL_READ_ACTIONS } from '../../../src/shared/constants/excelActions';

vi.mock('../../../src/host/cron/cronWriteGrant', async (original) => ({
  ...await original<typeof import('../../../src/host/cron/cronWriteGrant')>(),
  requiresScheduleWriteGrant: vi.fn(async () => false),
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-policy-'));
const workspace = path.join(root, 'workspace');
const outside = path.join(root, 'outside');
beforeAll(() => {
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(workspace, 'escape'), 'dir');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => getPermissionClassifier().clearCache());

async function production(params: Record<string, unknown>, workingDirectory = workspace, mode: PermissionMode = 'acceptEdits', overrides: Partial<Parameters<typeof resolveToolPermissionClassification>[0]> = {}) {
  return resolveToolPermissionClassification({
    executionToolName: 'ExcelAutomate', policyToolName: 'ExcelAutomate', params,
    policyForcesConfirmation: false, boundaryViolation: undefined,
    workingDirectory, workspaceRoot: workspace, permissionLevel: 'write',
    permStartTime: Date.now(), readOnlyForcesConfirmation: mode === 'readOnly', sessionPermissionMode: mode, ...overrides,
  });
}

describe('Excel action policy through production classification', () => {
  it('keeps explicit policy and skill boundaries even for read actions', async () => {
    const args = { action: 'read', file_path: path.join(outside, 'contract.xlsx') };
    expect((await production(args, workspace, 'acceptEdits', { policyForcesConfirmation: true })).decision).toBe('ask');
    expect((await production(args, workspace, 'acceptEdits', { boundaryViolation: { skillName: 'task-planning', allowedTools: ['Read'] } })).decision).toBe('ask');
  });
  it.each(['edit', 'generate'])('readOnly still asks for %s in the workspace', async (action) => {
    expect((await production({ action, file_path: 'summary.xlsx', output_path: 'summary.xlsx' }, workspace, 'readOnly')).decision).toBe('ask');
  });
  it('removes the tool-wide acceptEdits exception', () => {
    expect(mustAskUnderAcceptEdits('ExcelAutomate')).toBe(false);
  });
  it.each([...EXCEL_READ_ACTIONS])('outside read %s needs no card', async (action) => {
    const args = { action, file_path: path.join(outside, 'contract.xlsx') };
    expect((await production(args)).decision).toBe('approve');
    expect((await production(args, workspace, 'readOnly')).decision).toBe('approve');
    expect((await classifyPermission('ExcelAutomate', args, { workingDirectory: workspace, workspaceRoot: workspace, permissionLevel: 'write' })).decision).toBe('approve');
  });
  for (const action of ['edit', 'generate']) {
    const key = action === 'edit' ? 'file_path' : 'output_path';
    const cases: Array<[string, unknown, string | undefined, 'approve' | 'ask']> = [
      ['relative', 'summary.xlsx', path.join(workspace, 'summary.xlsx'), 'approve'],
      ['absolute inside', path.join(workspace, 'summary.xlsx'), path.join(workspace, 'summary.xlsx'), 'approve'],
      ['tilde', '~/Desktop/excel-policy.xlsx', path.join(os.homedir(), 'Desktop/excel-policy.xlsx'), 'ask'],
      ['absolute outside', path.join(outside, 'summary.xlsx'), path.join(outside, 'summary.xlsx'), 'ask'],
      ['dotdot', '../outside/summary.xlsx', path.join(outside, 'summary.xlsx'), 'ask'],
      ['symlink', 'escape/summary.xlsx', path.join(workspace, 'escape/summary.xlsx'), 'ask'],
      ['protected', '.npmrc', path.join(workspace, '.npmrc'), 'ask'],
      ['empty', '', undefined, 'ask'],
      ['invalid type', 123, undefined, 'ask'],
      ['nul', 'bad\0.xlsx', undefined, 'ask'],
    ];
    it.each(cases)(`${action} path parity: %s`, async (_name, raw, resolved, decision) => {
      const args = { action, [key]: raw };
      const targets = resolveExcelWriteTargets(args, workspace);
      expect(targets).toEqual(resolved ? [resolved] : []);
      const direct = await classifyPermission('ExcelAutomate', args, { workingDirectory: workspace, workspaceRoot: workspace, permissionLevel: 'write' });
      const actual = await production(args);
      expect(direct.decision).toBe(decision);
      expect(actual.decision).toBe(decision);
      if (resolved && decision === 'ask') expect(actual.hostReason?.metadata?.path).toBe(fs.existsSync(path.dirname(resolved)) ? path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)) : resolved);
    });
    it(`${action} keeps boundary ask under full access`, async () => {
      expect((await production({ action, [key]: '~/Desktop/no-grant.xlsx' }, workspace, 'bypassPermissions')).decision).toBe('ask');
    });
  }
  it('missing edit target asks', async () => {
    expect(resolveExcelWriteTargets({ action: 'edit' }, workspace)).toEqual([]);
    expect((await production({ action: 'edit' })).decision).toBe('ask');
  });
  it('generate default uses the resolved cwd and asks if cwd is outside workspace', async () => {
    const args = { action: 'generate' };
    expect((await production(args, outside)).decision).toBe('ask');
    expect(resolveExcelWriteTargets(args, outside)[0]).toMatch(new RegExp('spreadsheet-[0-9]+\\.xlsx$'));
    expect(path.dirname(resolveExcelWriteTargets(args, outside)[0])).toBe(outside);
    expect((await production({ action: 'generate' })).decision).toBe('approve');
  });
  it.each(['automate', 'unknown', undefined])('%s action asks rather than entering an LLM fallback', async (action) => {
    for (const mode of ['default', 'acceptEdits', 'readOnly', 'bypassPermissions'] as const) {
      expect((await production({ action }, workspace, mode)).decision).toBe('ask');
    }
  });
  it('does not reuse approval after a symlink changes destination', async () => {
    const link = path.join(workspace, 'retarget');
    fs.symlinkSync(workspace, link, 'dir');
    const args = { action: 'edit', file_path: 'retarget/summary.xlsx' };
    expect((await production(args)).decision).toBe('approve');
    fs.unlinkSync(link);
    fs.symlinkSync(outside, link, 'dir');
    expect((await production(args)).decision).toBe('ask');
  });
  it('retains conservative read security targets; writes use the shared destinations', () => {
    const definition: Parameters<typeof resolveToolWriteTargets>[0]['definition'] = {
      ...excelAutomateSchema, requiresPermission: true, permissionLevel: 'write',
      aliases: excelAutomateSchema.aliases ? [...excelAutomateSchema.aliases] : undefined,
    };
    expect(resolveToolWriteTargets({ definition, params: { action: 'read', file_path: path.join(outside, 'contract.xlsx') }, workingDirectory: workspace }).targets).toEqual([path.join(fs.realpathSync(outside), 'contract.xlsx')]);
    const params = { action: 'generate', output_path: 'summary.xlsx' };
    expect(resolveToolWriteTargets({ definition, params, workingDirectory: workspace }).targets).toEqual(resolveExcelWriteTargets(params, workspace).map(p => path.join(fs.realpathSync(path.dirname(p)), path.basename(p))));
  });
});
