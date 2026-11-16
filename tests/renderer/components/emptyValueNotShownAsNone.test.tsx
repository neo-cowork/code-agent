// @vitest-environment jsdom
// ============================================================================
// N-FIX-UI-EMPTY-VALUE-SHOWS-WU —— 空值不显示「无」
//   审批卡：空字段整行不渲染；设置页：无能力/无动作的连接器不出「能力: 无」
// ============================================================================
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const state = vi.hoisted(() => ({ request: null as PermissionRequest | null }));
const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: state.request,
    pendingPermissionSessionId: null,
    setPendingPermissionRequest: vi.fn(),
    language: 'zh',
    setLanguage: () => {},
    cloudUIStrings: undefined,
  }),
}));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) => selector({ currentSessionId: 's' }),
}));
vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke: vi.fn(), invokeDomain },
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: { error: vi.fn() } }));

import { PermissionCard } from '../../../src/renderer/components/PermissionDialog/PermissionCard';
import { NativeConnectorsSection } from '../../../src/renderer/components/features/settings/sections/NativeConnectorsSection';

describe('空值不显示「无」', () => {
  afterEach(() => { cleanup(); invokeDomain.mockReset(); });

  it('审批卡：空标题整行不渲染，有值的行保留', () => {
    state.request = {
      id: 'p1', sessionId: 'r', tool: 'mail_send', type: 'file_write', forceConfirm: true, dangerLevel: 'danger',
      details: { subject: '', to: ['a@b.com'], content: '正文' } as PermissionRequest['details'],
      timestamp: 1,
    };
    render(<PermissionCard />);
    expect(screen.queryByTestId('writeback-view-subject')).toBeNull();
    expect(screen.getByTestId('writeback-fields-view').textContent).not.toContain('无');
    expect(screen.getByTestId('writeback-view-to').textContent).toContain('a@b.com');
  });

  it('设置页：无能力、无动作的连接器不出现「无」占位', async () => {
    invokeDomain.mockImplementation((_d: string, action: string) => {
      if (action === 'listNativeInventory') return Promise.resolve([{ id: 'photos', label: '照片', enabled: false }]);
      if (action === 'listStatuses') return Promise.resolve([{ id: 'photos', label: '照片', connected: false, readiness: 'unavailable', capabilities: [] }]);
      return Promise.resolve(undefined);
    });
    const { container } = render(React.createElement(NativeConnectorsSection, { presentation: 'diagnostic' }));
    await screen.findByText(/照片/);
    expect(container.textContent).not.toMatch(/能力: ?无|可用动作: ?无/);
  });

  it('词典里不再有表示空值的「无 / None」键', () => {
    for (const t of [zh, en]) {
      const s = JSON.stringify([t.settings.nativeConnectors, t.decisionCard.permission.writeback]);
      expect(s).not.toMatch(/"(none|empty)":"(无|None)"/);
    }
  });
});
