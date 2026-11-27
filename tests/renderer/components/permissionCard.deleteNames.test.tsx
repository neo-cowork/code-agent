// @vitest-environment jsdom
// N-FIX-APPROVAL-CARD-DELETE-CONSEQUENCE-NAMES-ONLY-FIRST-FILE（FB-1618）：卡面上的删除
// 后果行（data-testid="permission-consequence"）对多目标 rm 点名每个目标，混了通配符的
// 命令不点名任何文件，单文件删除保持原句。走 PermissionCard 的真实渲染路径。
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';

const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return { useI18n: () => ({ t: i18nState.language === 'en' ? en : zh, language: i18nState.language }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: null,
    pendingPermissionSessionId: null,
    setPendingPermissionRequest: vi.fn(),
    recordPermissionDecision: vi.fn(),
    developerMode: false,
  }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { currentSessionId: string }) => unknown) => selector({ currentSessionId: 'session-current' }),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn() } }));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';

function rmRequest(id: string, command: string, details: PermissionRequest['details'] = {}): PermissionRequest {
  return {
    id,
    sessionId: 'request-session',
    tool: 'Bash',
    type: 'dangerous_command',
    dangerLevel: 'danger',
    details: { command, commandRiskLevel: 'high', commandSecurityFlags: ['recursive_delete_targeted'], ...details },
    boundary: { id: 'command.shell' },
    timestamp: 1,
  };
}

// 宿主对确切多目标命令的真实下发形状：affectedPath 只是第一个目标，计数是全部之和。
const fiveLogs = rmRequest('delete-five', 'rm -rf a.log b.log c.log d.log e.log', {
  affectedPath: '/workspace/logs/a.log',
  affectedFileCount: 5,
});
const mixedWildcard = rmRequest('delete-mixed', 'rm -rf a.log *.log', { affectedPath: '/workspace/logs/a.log' });
const singleFile = rmRequest('delete-single', 'rm -rf a.log', { affectedPath: '/workspace/logs/a.log', affectedFileCount: 1 });

function consequenceOf(request: PermissionRequest, language: 'zh' | 'en'): string | null {
  i18nState.language = language;
  render(<PermissionCard requestOverride={request} sessionIdOverride="session-current" />);
  return screen.getByTestId('permission-consequence').textContent;
}

describe('PermissionCard delete consequence names', () => {
  afterEach(() => {
    cleanup();
    i18nState.language = 'zh';
  });

  it.each([
    ['zh', '将永久删除 a.log、b.log、c.log 等 5 个（约 5 个文件），不进回收站。'],
    ['en', 'Permanently deletes a.log, b.log, c.log and 2 more (5 files) without using Trash.'],
  ] as const)('%s: 5 个确切目标点名前 3 个并写出总数', (language, expected) => {
    expect(consequenceOf(fiveLogs, language)).toBe(expected);
  });

  it.each([
    ['zh', '将永久删除多个文件，不进回收站。'],
    ['en', 'Permanently deletes multiple files without using Trash.'],
  ] as const)('%s: 混了通配符的命令不点名 a.log', (language, expected) => {
    const text = consequenceOf(mixedWildcard, language);
    expect(text).toBe(expected);
    expect(text).not.toContain('a.log');
  });

  it.each([
    ['zh', '将永久删除 /workspace/logs/a.log（约 1 个文件），不进回收站。'],
    ['en', 'Permanently deletes /workspace/logs/a.log (1 file) without using Trash.'],
  ] as const)('%s: 单文件删除保持原句', (language, expected) => {
    expect(consequenceOf(singleFile, language)).toBe(expected);
  });
});
