// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
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
  useSessionStore: (selector: (state: { currentSessionId: string }) => unknown) => selector({ currentSessionId: 'session-bg-delete' }),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn() } }));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { releaseApprovalResponse } from '../../../src/renderer/utils/approvalResponseGuard';

function makeBackgroundDeleteRequest(id = 'perm-bg-rm-1'): PermissionRequest {
  return {
    id,
    sessionId: 'session-bg-delete',
    tool: 'Bash',
    type: 'command',
    reason: 'Recursive/forced deletion of a specific path',
    reasonCode: 'shell_high_risk',
    details: {
      command: 'rm -v ~/old-cache/preview-cache.tmp ~/old-cache/draft-backup.bak',
      commandRiskLevel: 'high',
      commandSecurityFlags: ['recursive_delete_targeted'],
      affectedPath: '~/old-cache/preview-cache.tmp',
      affectedFileCount: 2,
      sandbox: { applied: true, degraded: false, code: 'OS_SANDBOX_APPLIED' },
      grantEligible: true,
      userRequest: {
        text: '帮我在后台清理旧草稿和 ~/old-cache/ 下的旧缓存文件',
        truncated: false,
      },
    },
    boundary: { id: 'command.shell' },
    timestamp: 1,
  };
}

describe('PermissionCard background delete card hides shortcut badges and keyboard hint copy', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    i18nState.language = 'zh';
    for (const id of ['perm-bg-rm-1', 'perm-bg-rm-y', 'perm-bg-rm-n', 'perm-bg-rm-s']) {
      releaseApprovalResponse(id);
    }
  });

  it.each(['zh', 'en'] as const)('renders no kbd badges, keyboard hints, or internal reason strings in %s (expanded and folded)', (language) => {
    i18nState.language = language;
    render(<PermissionCard requestOverride={makeBackgroundDeleteRequest()} sessionIdOverride="session-bg-delete" />);

    const card = screen.getByTestId('permission-card');
    expect(card.firstElementChild?.getAttribute('data-view-mode')).toBe('expanded');
    expect(card.querySelectorAll('kbd')).toHaveLength(0);

    const expandedText = card.textContent ?? '';
    expect(expandedText).not.toMatch(/y[：:]\s*(允许|allow)/i);
    expect(expandedText).not.toMatch(/n[：:]\s*(暂不|not now)/i);
    expect(expandedText).not.toContain('recursive_delete_targeted');
    expect(expandedText).not.toContain('Recursive/forced deletion of a specific path');
    expect(expandedText).not.toContain('rm_exit');
    expect(expandedText).not.toContain('2>&1');

    const secondary = screen.getByTestId('permission-secondary-choices');
    expect(secondary.querySelectorAll('kbd')).toHaveLength(0);
    expect(secondary.textContent).toContain(language === 'zh' ? '本次任务内允许' : 'Allow for this task');
    expect(secondary.textContent).toContain(language === 'zh' ? '24 小时内允许' : 'Allow for 24 hours');

    const collapseBtn = screen.getByRole('button', { name: language === 'zh' ? '收起▴' : 'Collapse ▴' });
    fireEvent.click(collapseBtn);
    expect(card.firstElementChild?.getAttribute('data-view-mode')).toBe('compact');
    expect(card.querySelectorAll('kbd')).toHaveLength(0);
    const foldedText = card.textContent ?? '';
    expect(foldedText).not.toContain('rm -v');
    expect(foldedText).not.toMatch(/y[：:]\s*(允许|allow)/i);
  });

  it('keeps y/n/s keyboard shortcuts working after removing visual kbd badges and hint copy', async () => {
    const first = render(<PermissionCard requestOverride={makeBackgroundDeleteRequest('perm-bg-rm-y')} sessionIdOverride="session-bg-delete" />);
    fireEvent.keyDown(window, { key: 'y' });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('agent:permission-response', 'perm-bg-rm-y', 'allow', 'session-bg-delete');
    });
    first.unmount();

    const second = render(<PermissionCard requestOverride={makeBackgroundDeleteRequest('perm-bg-rm-n')} sessionIdOverride="session-bg-delete" />);
    fireEvent.keyDown(window, { key: 'n' });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('agent:permission-response', 'perm-bg-rm-n', 'deny', 'session-bg-delete');
    });
    second.unmount();

    const third = render(<PermissionCard requestOverride={makeBackgroundDeleteRequest('perm-bg-rm-s')} sessionIdOverride="session-bg-delete" />);
    fireEvent.keyDown(window, { key: 's' });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('agent:permission-response', 'perm-bg-rm-s', 'allow_run', 'session-bg-delete');
    });
    third.unmount();
  });
});
