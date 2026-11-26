// @vitest-environment jsdom
// 审批卡（PermissionCard 入口）：工作区外读文件时，文字与 title 都不露 /Users/<账户>。
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    workingDirectory: '/Users/alice/work/foo',
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
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

const readOutside: PermissionRequest = {
  id: 'permission-read-outside',
  sessionId: 'request-session',
  tool: 'Read',
  type: 'file_read',
  details: { path: '/Users/alice/Documents/a.txt' },
  timestamp: 1,
};

const readOf = (path: string, id: string): PermissionRequest => ({ ...readOutside, id, details: { path } });
const LONG_SYSTEM_PATH = '/Library/Application Support/com.example.vendor/LaunchDaemons/helpers/tools/com.example.helper.plist';

afterEach(() => {
  cleanup();
  for (const id of [readOutside.id, 'read-sys', 'read-long']) releaseApprovalResponse(id);
});

function openCard(request: PermissionRequest) {
  render(<PermissionCard requestOverride={request} sessionIdOverride="session-current" />);
  fireEvent.click(screen.getByRole('button', { name: /详情|Details/ }));
  return screen.getByTestId('permission-card');
}

describe.each(['zh', 'en'] as const)('审批卡路径不露绝对路径 (%s)', (language) => {
  it('工作区外 Read：卡上文字与所有 title 不含 /Users/，文件行显示 ~/Documents/a.txt', () => {
    i18nState.language = language;
    render(<PermissionCard requestOverride={readOutside} sessionIdOverride="session-current" />);
    fireEvent.click(screen.getByRole('button', { name: /详情|Details/ }));
    const card = screen.getByTestId('permission-card');
    expect(card.innerHTML).not.toContain('/Users/');
    expect(card.textContent).toContain('~/Documents/a.txt');
    const titles = Array.from(card.querySelectorAll('[title]')).map((el) => el.getAttribute('title'));
    expect(titles).toContain('~/Documents/a.txt');
  });
});

describe.each(['zh', 'en'] as const)('审批卡系统路径保留完整位置 (%s)', (language) => {
  it('/etc/ssh/sshd_config：文字与 title 都是完整路径，不退化成 ssh/sshd_config', () => {
    i18nState.language = language;
    const card = openCard(readOf('/etc/ssh/sshd_config', 'read-sys'));
    const row = card.querySelector('[title="/etc/ssh/sshd_config"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toBe('/etc/ssh/sshd_config');
  });

  it('超过 60 字符的系统路径：可见行以根段开头并中段省略，title 是完整路径', () => {
    i18nState.language = language;
    expect(LONG_SYSTEM_PATH.length).toBeGreaterThan(60);
    const card = openCard(readOf(LONG_SYSTEM_PATH, 'read-long'));
    const row = card.querySelector(`[title="${LONG_SYSTEM_PATH}"]`);
    expect(row).not.toBeNull();
    expect(row!.textContent!.startsWith('/Library/…/')).toBe(true);
    expect(row!.textContent).toContain('…');
    expect(row!.textContent).toMatch(/\/tools\/com\.example\.helper\.plist$/);
  });
});
