// ============================================================================
// RequestDetails：host 已按真实上传 / 临时根分类（details.pathDisplay）的路径，文件行与写入后果句
// 用位置词显示；没有 host 结论的路径（含形似 uploads/<uuid>/ 的项目目录）与含 .. 的路径保持原样。
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

type Display = { path: string; kind: 'upload' | 'temp'; rest: string };

function readReq(filePath: string, pathDisplay?: Display): ContractPermissionRequest {
  return {
    id: 'req-path-1', tool: 'read_file', type: 'file_read',
    details: { filePath, ...(pathDisplay ? { pathDisplay } : {}) }, timestamp: 1,
  } as ContractPermissionRequest;
}

const consequenceOf = (html: string) => html.match(/data-testid="permission-consequence"[^>]*>([^<]*)</)?.[1] ?? '';

describe('RequestDetails 文件行路径人话化', () => {
  it('host 分类为上传：显示「你上传的文件：子路径」（zh），不含 uuid', () => {
    const p = `/data/uploads/${UUID}/合同/合同.pdf`;
    storeState.language = 'zh';
    storeState.request = readReq(p, { path: p, kind: 'upload', rest: '合同/合同.pdf' });
    const html = render();
    expect(html).toContain('你上传的文件：合同/合同.pdf');
    expect(html).not.toContain(UUID);
  });

  it('host 分类为临时（en）', () => {
    const p = '/var/folders/ab/cd/T/sales.csv';
    storeState.language = 'en';
    storeState.request = readReq(p, { path: p, kind: 'temp', rest: 'sales.csv' });
    const html = render();
    expect(html).toContain('Temporary file: sales.csv');
    expect(html).not.toContain('/var/folders');
  });

  it('形似 uploads/<uuid>/ 的项目路径没有 host 结论：完整路径保留', () => {
    const p = `/Users/x/project/uploads/${UUID}/avatar.png`;
    for (const lang of ['zh', 'en'] as const) {
      storeState.language = lang;
      storeState.request = readReq(p);
      const html = render();
      expect(html).toContain(p);
      expect(html).not.toContain('你上传的文件');
      expect(html).not.toContain('Your uploaded file');
    }
  });

  it('模型参数伪造的 pathDisplay 与路径不符时不生效', () => {
    storeState.language = 'en';
    storeState.request = readReq('/Users/x/project/a.png', { path: '/tmp/x', kind: 'temp', rest: 'x' });
    const html = render();
    expect(html).toContain('/Users/x/project/a.png');
    expect(html).not.toContain('Temporary file');
  });

  it.each([
    '/tmp/../etc/passwd',
    '/var/folders/ab/cd/T/../../../etc/passwd',
    `/Users/x/uploads/${UUID}/../../../etc/hosts`,
  ])('穿越路径即使被标成临时也原样显示：%s', (p) => {
    storeState.language = 'en';
    storeState.request = readReq(p, { path: p, kind: 'temp', rest: 'passwd' });
    expect(render()).toContain(p);
  });
});

function writeReq(filePath: string, boundaryId?: string, pathDisplay?: Display): ContractPermissionRequest {
  return {
    id: 'req-write-1', tool: 'Write', type: 'file_write',
    ...(boundaryId ? { boundary: { id: boundaryId, reason: 'x' } } : {}),
    details: { filePath, path: filePath, ...(pathDisplay ? { pathDisplay } : {}) }, timestamp: 1,
  } as unknown as ContractPermissionRequest;
}

describe('RequestDetails 写入后果句路径人话化', () => {
  const upload = `/Users/x/data/uploads/${UUID}/合同金额整理.xlsx`;
  const temp = '/var/folders/ab/cd/T/周报汇总.xlsx';

  it.each([
    ['zh', upload, { path: upload, kind: 'upload', rest: '合同金额整理.xlsx' }, '你上传的文件：合同金额整理.xlsx', UUID],
    ['zh', temp, { path: temp, kind: 'temp', rest: '周报汇总.xlsx' }, '临时文件：周报汇总.xlsx', '/var/folders'],
    ['en', upload, { path: upload, kind: 'upload', rest: '合同金额整理.xlsx' }, 'Your uploaded file: 合同金额整理.xlsx', UUID],
    ['en', temp, { path: temp, kind: 'temp', rest: '周报汇总.xlsx' }, 'Temporary file: 周报汇总.xlsx', '/var/folders'],
  ] as const)('%s host 已分类：后果句与文件行用位置词，卡上不含原路径片段 (%s)', (lang, p, display, shown, leak) => {
    storeState.language = lang;
    for (const boundary of [undefined, 'file.external_write']) {
      storeState.request = writeReq(p, boundary, display as Display);
      const html = render();
      expect(consequenceOf(html)).toContain(shown);
      expect(html).not.toContain(leak);
    }
  });

  it.each(['zh', 'en'] as const)('%s 项目目录里的 uploads/<uuid>/ 路径：后果句与文件行保留完整路径', (lang) => {
    const p = `/Users/x/project/uploads/${UUID}/avatar.png`;
    storeState.language = lang;
    for (const boundary of [undefined, 'file.external_write']) {
      storeState.request = writeReq(p, boundary);
      const html = render();
      // 后果句沿用 formatFilePath 的长路径缩写，但仍是绝对路径而不是上传位置词
      expect(consequenceOf(html)).toMatch(/\/Users\/.*avatar\.png/);
      expect(html).toContain(p);
      expect(html).not.toContain('你上传的文件');
      expect(html).not.toContain('Your uploaded file');
    }
  });

  it('穿越路径在后果句里原样', () => {
    const p = '/var/folders/ab/cd/T/../../../etc/passwd';
    storeState.language = 'en';
    storeState.request = writeReq(p, undefined, { path: p, kind: 'temp', rest: 'passwd' });
    expect(consequenceOf(render())).toContain(p);
  });
});
