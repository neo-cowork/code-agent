// @vitest-environment jsdom
// N-CUA-SCREEN-GUARDS-SENSITIVE-PROBE-FU2：ADR-088 交回卡渲染判据（规格 §3）。
// 真 PermissionCard（store mock 骨架照抄 permissionCard.sandboxEscalate.test.tsx）：
// 请求形状 = toolExecutor decorateSensitiveStepRequest 的产物（host 测试同一组字段断言）。
// 判据：asking/waiting/终态各状态的按钮组与文案；全卡不出现「本会话允许 / 始终允许」；
// 应答只发 allow/deny（无新应答值）；被键入文本不进卡片；停车单状态卡（收件箱行）。
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest as ContractPermissionRequest } from '../../../src/shared/contract/permission';

const storeState = vi.hoisted(() => ({
  request: null as ContractPermissionRequest | null,
  language: 'zh' as 'zh' | 'en',
}));

const ipcInvoke = vi.hoisted(() => vi.fn());
const memory = vi.hoisted(() => ({ check: vi.fn(() => 'session'), save: vi.fn() }));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const [{ zh: zhMessages }, { en: enMessages }] = await Promise.all([
    import('../../../src/renderer/i18n/zh'),
    import('../../../src/renderer/i18n/en'),
  ]);
  return {
    useI18n: () => ({
      t: storeState.language === 'en' ? enMessages : zhMessages,
      language: storeState.language,
    }),
  };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: storeState.request,
    pendingPermissionSessionId: null,
    setPendingPermissionRequest: vi.fn(),
    dismissPermissionRequest: vi.fn(),
    recordPermissionDecision: vi.fn(),
    developerMode: false,
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: { currentSessionId: string | null }) => unknown) =>
    selector({ currentSessionId: null }),
}));

vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: memory.check, saveMemory: memory.save }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => true, invoke: ipcInvoke },
}));

const { PermissionCard } = await import('../../../src/renderer/components/PermissionDialog/PermissionCard');
afterEach(() => { cleanup(); memory.check.mockClear(); memory.save.mockClear(); });
describe('browser session card', () => {
  it.each(['zh', 'en'] as const)('%s shows earlier site in human language and never consumes old broad memory', (language) => {
    storeState.language = language;
    storeState.request = { id: `browser-${language}`, tool: 'Browser', type: 'command', timestamp: 1,
      details: { action: 'wait_for_download', browserSessionGrant: { target: 'wait_for_download@http://127.0.0.1:8123', previousOrigins: ['http://localhost:8123'] } } };
    const { container } = render(<PermissionCard />);
    expect(screen.getByText(language === 'en' ? 'Website action' : '网站操作')).toBeTruthy();
    const reason = screen.getByTestId('browser-session-reason');
    expect(reason.textContent).toContain('http://localhost:8123');
    expect(reason.textContent).toContain('http://127.0.0.1:8123');
    expect(container.textContent).not.toContain('wait_for_download');
    expect(container.textContent).not.toContain('Browser');
    expect(screen.queryByRole('button', { name: /始终允许|Always allow|24 小时内允许|Allow for 24 hours/ })).toBeNull();
    expect(memory.check).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /本次对话允许|Allow for this session/ }));
    expect(memory.save).not.toHaveBeenCalled();
    expect(ipcInvoke).toHaveBeenCalledWith('agent:permission-response', `browser-${language}`, 'allow_run', undefined);
  });
  it.each(['zh', 'en'] as const)('%s offers only allow once and deny for dialog, clipboard and unresolved sites', (language) => {
    storeState.language = language;
    for (const action of ['handle_dialog', 'read_clipboard', 'write_clipboard', 'wait_for_download', 'open']) {
      for (const target of [`${action}@https://reports.example`, null]) {
        storeState.request = { id: `${action}-${target}`, tool: 'Browser', type: 'command', timestamp: 1,
          details: { action, browserSessionGrant: { target, previousOrigins: [] } } };
        render(<PermissionCard />);
        expect(screen.getByRole('button', { name: /允许一次|Allow once/ })).toBeTruthy();
        expect(screen.getByRole('button', { name: /拒绝|Deny/ })).toBeTruthy();
        const remember = screen.queryByRole('button', { name: /本次对话允许|Allow for this session/ });
        expect(Boolean(remember)).toBe(Boolean(target && ['wait_for_download', 'open'].includes(action)));
        cleanup();
      }
    }
  });

});
