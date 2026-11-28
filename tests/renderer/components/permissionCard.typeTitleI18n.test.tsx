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
  // 措辞以 main 的语言包为准（#3605 把标题改成按工具名统一取词：写入文件 / Write file、运行命令 / Run command）。
  it('写文件：中文「写入文件」，英文 Write file 且整卡无中文', () => {
    // 标题在展开态的卡头里：折叠态先点「更多选项与详情」（#4034 的改版卡），默认展开的卡不用点
    const expand = (current: 'zh' | 'en') => {
      const toggle = screen.queryByRole('button', { name: languages[current].decisionCard.permission.moreOptionsDetails });
      if (toggle) fireEvent.click(toggle);
    };
    lang.current = 'zh';
    const zh = render(<PermissionCard requestOverride={writeRequest} sessionIdOverride="session-current" />);
    expand('zh');
    expect(zh.container.textContent).toContain('写入文件');
    cleanup();

    lang.current = 'en';
    const en = render(<PermissionCard requestOverride={writeRequest} sessionIdOverride="session-current" />);
    expand('en');
    expect(en.container.textContent).toContain('Write file');
    expect(en.container.textContent).not.toMatch(HAN);
  });

  it('八种权限类型的标题：中文是语言包里的词条，英文都不含中文', () => {
    const pick = (p: (typeof languages)['zh']['decisionCard']['permission']) => ({
      file_read: p.titleFileRead,
      file_write: p.titleFileWrite,
      file_edit: p.titleFileEdit,
      file_delete: p.titleFileDelete,
      command: p.titleCommand,
      dangerous_command: p.titleDangerousCommand,
      network: p.titleNetwork,
      mcp: p.titleMcp,
    });
    expect(pick(languages.zh.decisionCard.permission)).toEqual({
      file_read: '读取文件',
      file_write: '写入文件',
      file_edit: '编辑文件',
      file_delete: '删除文件',
      command: '运行命令',
      dangerous_command: '危险命令',
      network: '网络请求',
      mcp: 'MCP 工具',
    });
    for (const title of Object.values(pick(languages.en.decisionCard.permission))) expect(title).not.toMatch(HAN);
  });
});
