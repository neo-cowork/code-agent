import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyPermission, getPermissionClassifier } from '../../../src/host/tools/permissionClassifier';
import { resolveToolPermissionClassification } from '../../../src/host/tools/toolPermissionClassification';
import { EXCEL_READ_ACTIONS } from '../../../src/shared/constants/excelActions';

vi.mock('../../../src/host/cron/cronWriteGrant', async (original) => ({
  ...await original<typeof import('../../../src/host/cron/cronWriteGrant')>(),
  requiresScheduleWriteGrant: vi.fn(async () => false),
}));

const workspace = path.join(os.tmpdir(), 'excel-sensitive-ws');
beforeEach(() => getPermissionClassifier().clearCache());

describe('ExcelAutomate read actions keep the credential read check', () => {
  const paths = ['~/.ssh/id_rsa', path.join(os.homedir(), '.aws', 'credentials')];
  for (const action of EXCEL_READ_ACTIONS) for (const file_path of paths) {
    it(`${action} ${file_path} asks`, async () => {
      const args = { action, file_path };
      const r = await classifyPermission('ExcelAutomate', args, { workingDirectory: workspace, workspaceRoot: workspace, permissionLevel: 'write' });
      expect(r.decision).toBe('ask');
      for (const mode of ['acceptEdits', 'default', 'readOnly'] as const) {
        const p = await resolveToolPermissionClassification({
          executionToolName: 'ExcelAutomate', policyToolName: 'ExcelAutomate', params: args,
          policyForcesConfirmation: false, boundaryViolation: undefined,
          workingDirectory: workspace, workspaceRoot: workspace, permissionLevel: 'write',
          permStartTime: Date.now(), readOnlyForcesConfirmation: mode === 'readOnly', sessionPermissionMode: mode,
        });
        expect(p.decision).toBe('ask');
      }
    });
  }
});
