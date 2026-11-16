// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';

const lang = vi.hoisted(() => ({ current: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { languages } = await import('../../../src/renderer/i18n');
  return { useI18n: () => ({ t: languages[lang.current], language: lang.current }) };
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
import { languages } from '../../../src/renderer/i18n';

const HAN = /[㐀-䶿一-鿿豈-﫿]/u;

const writeRequest: PermissionRequest = {
  id: 'permission-write',
  sessionId: 'session-current',
  tool: 'Write',
  type: 'file_write',
  details: { path: '/workspace/reports/report.md' },
  boundary: { id: 'file.project_write' },
  timestamp: 1,
};

afterEach(cleanup);

describe('审批卡按权限类型给的标题跟随界面语言（FB-1151）', () => {
  it('写文件：中文「创建文件」，英文 Create file 且整卡无中文', () => {
    // 标题在展开态的卡头里：先点「详情」
    lang.current = 'zh';
    const zh = render(<PermissionCard requestOverride={writeRequest} sessionIdOverride="session-current" />);
    fireEvent.click(screen.getByRole('button', { name: languages.zh.decisionCard.details }));
    expect(zh.container.textContent).toContain('创建文件');
    cleanup();

    lang.current = 'en';
    const en = render(<PermissionCard requestOverride={writeRequest} sessionIdOverride="session-current" />);
    fireEvent.click(screen.getByRole('button', { name: languages.en.decisionCard.details }));
    expect(en.container.textContent).toContain('Create file');
    expect(en.container.textContent).not.toMatch(HAN);
  });

  it('八种权限类型的标题：中文与改动前逐字相同，英文都不含中文', () => {
    expect(languages.zh.decisionCard.permission.typeTitles).toEqual({
      file_read: '读取文件',
      file_write: '创建文件',
      file_edit: '编辑文件',
      file_delete: '删除文件',
      command: '执行命令',
      dangerous_command: '危险命令',
      network: '网络请求',
      mcp: 'MCP 工具',
    });
    const en = languages.en.decisionCard.permission.typeTitles;
    expect(Object.keys(en).sort()).toEqual(Object.keys(languages.zh.decisionCard.permission.typeTitles).sort());
    for (const title of Object.values(en)) expect(title).not.toMatch(HAN);
  });
});
