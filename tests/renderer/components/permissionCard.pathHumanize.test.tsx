// ============================================================================
// （N-PARKED-APPROVAL-SURVIVE-RESTART-PERSIST ④）
// 判据：request.argsPreview 在时渲染预览块（zh/en 两种词条都验证），不在时不渲染。
// 预览文本由 host parkApproval 脱敏 + 截断，renderer 只负责呈现，不再二次加工。
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

const { RequestDetails } = await import('../../../src/renderer/components/PermissionDialog/RequestDetails');

function render(): string {
  return renderToStaticMarkup(React.createElement(RequestDetails, { request: storeState.request as never }));
}

const UUID = '3ab3c0de-1111-4222-8333-444455556666';

function readReq(filePath: string): ContractPermissionRequest {
  return {
    id: 'req-path-1', tool: 'read_file', type: 'file_read',
    details: { filePath }, timestamp: 1,
  } as ContractPermissionRequest;
}

describe('RequestDetails 文件行路径人话化', () => {
  it('上传目录路径显示为「你上传的文件：子路径」（zh），不含 uuid', () => {
    storeState.language = 'zh';
    storeState.request = readReq(`/Users/x/uploads/${UUID}/合同/合同.pdf`);
    const html = render();
    expect(html).toContain('你上传的文件：合同/合同.pdf');
    expect(html).not.toContain(UUID);
  });

  it('临时目录路径（en）', () => {
    storeState.language = 'en';
    storeState.request = readReq('/var/folders/ab/cd/T/sales.csv');
    const html = render();
    expect(html).toContain('Temporary file: sales.csv');
    expect(html).not.toContain('/var/folders');
  });

  it.each([
    '/tmp/../etc/passwd',
    '/var/folders/ab/cd/T/../../../etc/passwd',
    `/Users/x/uploads/${UUID}/../../../etc/hosts`,
  ])('穿越路径原样显示：%s', (p) => {
    storeState.language = 'en';
    storeState.request = readReq(p);
    expect(render()).toContain(p);
  });
});

function writeReq(filePath: string, boundaryId?: string): ContractPermissionRequest {
  return {
    id: 'req-write-1', tool: 'excel_generate', type: 'file_write',
    ...(boundaryId ? { boundary: { id: boundaryId, reason: 'x' } } : {}),
    details: { filePath, path: filePath }, timestamp: 1,
  } as unknown as ContractPermissionRequest;
}

describe('RequestDetails 写入后果句路径人话化', () => {
  const upload = `/Users/x/work/out/rr/neo/home/.code-agent/uploads/${UUID}/合同金额整理.xlsx`;
  const temp = '/var/folders/ab/cd/T/周报汇总.xlsx';

  it.each([
    ['zh', upload, '你上传的文件：合同金额整理.xlsx', UUID],
    ['zh', temp, '临时文件：周报汇总.xlsx', '/var/folders'],
    ['en', upload, 'Your uploaded file: 合同金额整理.xlsx', UUID],
    ['en', temp, 'Temporary file: 周报汇总.xlsx', '/var/folders'],
  ] as const)('%s file_write consequence + file row hide the raw path (%s)', (lang, p, shown, leak) => {
    storeState.language = lang;
    for (const boundary of [undefined, 'file.external_write']) {
      storeState.request = writeReq(p, boundary);
      const html = render();
      const consequence = html.match(/data-testid="permission-consequence"[^>]*>([^<]*)</)?.[1] ?? '';
      expect(consequence).toContain(shown);
      expect(html).not.toContain(leak);
    }
  });

  it('traversal path stays verbatim in the consequence sentence', () => {
    storeState.language = 'en';
    storeState.request = writeReq('/var/folders/ab/cd/T/../../../etc/passwd');
    const html = render();
    expect(html.match(/data-testid="permission-consequence"[^>]*>([^<]*)</)?.[1]).toContain('/var/folders/ab/cd/T/../../../etc/passwd');
  });
});
