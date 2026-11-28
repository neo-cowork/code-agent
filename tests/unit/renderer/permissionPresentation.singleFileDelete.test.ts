import { expect, it } from 'vitest';
import type { PermissionRequest } from '../../../src/renderer/components/PermissionDialog/types';
import {
  defaultPermissionViewMode,
  isHighRiskCommandRequest,
  isSafeDefaultDeny,
  permissionConsequence,
} from '../../../src/renderer/components/PermissionDialog/permissionPresentation';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';

it('keeps the single-file deletion card compact with a named consequence and default deny', () => {
  const target = '/workspace/old-notes.txt';
  const request: PermissionRequest = {
    id: 'permission-test',
    sessionId: 'session-test',
    type: 'command',
    tool: 'Bash',
    details: {
      command: `rm "${target}"`,
      commandRiskLevel: 'medium',
      commandSecurityFlags: ['single_file_delete'],
      affectedPath: target,
      affectedFileCount: 1,
    },
  };
  expect(isHighRiskCommandRequest(request)).toBe(false);
  expect(defaultPermissionViewMode(request)).toBe('compact');
  expect(isSafeDefaultDeny(request)).toBe(true);
  expect(permissionConsequence(request, zh, 'zh')).toContain('old-notes.txt');
  expect(permissionConsequence(request, en, 'en')).toContain('old-notes.txt');
});
