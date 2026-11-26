// ============================================================================
// 浏览器上传审批卡：写明附加的是哪个文件、一次性交给网页，不露路径/内部名。
// ============================================================================
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest as ContractPermissionRequest } from '../../../src/shared/contract/permission';

// PermissionCard 是 store 连接型组件（无 props），mock 三个 store + ipcService
// 后用 renderToStaticMarkup 渲染（与 permissionCard.reason.test.tsx 同一模式）。
const storeState = vi.hoisted(() => ({
  request: null as ContractPermissionRequest | null,
  language: 'zh' as 'zh' | 'en',
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  const { en } = await import('../../../src/renderer/i18n/en');
  return {
    useI18n: () => ({
      t: storeState.language === 'en' ? en : zh,
      language: storeState.language,
    }),
  };
});

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: () => ({
    pendingPermissionRequest: storeState.request,
    pendingPermissionSessionId: null,
    setPendingPermissionRequest: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: { currentSessionId: string | null }) => unknown) =>
    selector({ currentSessionId: null }),
}));

vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invoke: vi.fn() },
}));

const { PermissionCard } = await import('../../../src/renderer/components/PermissionDialog/PermissionCard');


function req(overrides: Partial<ContractPermissionRequest>): ContractPermissionRequest {
  return { id: 'req-upload-1', tool: 'browser_action.upload_file', type: 'file_read', details: {}, timestamp: 1, ...overrides };
}

function render(language: 'zh' | 'en', request: ContractPermissionRequest): string {
  storeState.language = language;
  storeState.request = request;
  return renderToStaticMarkup(React.createElement(PermissionCard));
}

const text = (html: string) => html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
const upload = { file: '.../invoice.pdf', action: 'upload_file', engine: 'managed', approvalMode: 'host_one_time_exact_file', sizeBytes: 50, sha256: 'abcdef012345' };

describe('浏览器上传审批卡', () => {
  it('zh：标题/问句带文件名，后果行说明一次性，卡面不露内部名', () => {
    const out = text(render('zh', req({ forceConfirm: true, details: upload as never })));
    expect(out).toContain('向网页附加文件');
    expect(out).toContain('允许把「invoice.pdf」附加到这个网页吗？');
    expect(out).toContain('只会把这一个文件一次性交给网页，不会读取其他文件。');
    for (const leak of ['读取文件', '操作网页', 'upload_file', 'selector', '.../', 'abcdef012345', 'host_one_time']) {
      expect(out).not.toContain(leak);
    }
  });

  it('en：全英文，只露文件名', () => {
    const out = text(render('en', req({ forceConfirm: true, details: { ...upload, file: '/Users/a/work/invoice.pdf' } as never })));
    expect(out).toContain('Attach a file to this page');
    expect(out).toContain('Attach &quot;invoice.pdf&quot; to this page?');
    expect(out).toContain('nothing else is read');
    expect(out).not.toContain('/Users/a/work');
    expect(out).not.toMatch(/[\u4e00-\u9fff]/u);
  });

  it('没有文件名的 upload 请求仍走通用网页操作卡', () => {
    const out = text(render('zh', req({ details: { action: 'upload_file' } as never })));
    expect(out).toContain('操作网页');
    expect(out).not.toContain('向网页附加文件');
  });
});
