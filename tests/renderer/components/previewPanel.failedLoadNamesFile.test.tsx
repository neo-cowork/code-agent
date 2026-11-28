// @vitest-environment jsdom
// 加载失败的错误面板必须点名失败的文件；Retry 之后 tab/路径/文件名不变。
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../../../src/renderer/components/PreviewPanel';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const MISSING = '/work/attach/dogfood-3752-并行检查.txt';

beforeEach(() => {
  (window as unknown as { domainAPI: unknown }).domainAPI = {
    invoke: vi.fn(async (_d: string, action: string) => {
      if (action === 'readTextPreview') {
        return { success: false, error: { message: `ENOENT: ${MISSING}` } };
      }
      if (action === 'getPublishInfo') return { success: true, data: { publishState: { kind: 'draft' }, publishedVersions: [] } };
      return { success: true, data: null };
    }),
  };
  useAppStore.setState({ previewTabs: [], workbenchTabs: [], activePreviewTabId: null, language: 'zh' } as never);
  useAppStore.getState().openPreview(MISSING);
});
afterEach(() => {
  delete (window as unknown as { domainAPI?: unknown }).domainAPI;
  cleanup();
});

describe('PreviewPanel failed load names the file', () => {
  it('error panel includes the failed file basename, also after Retry; tab unchanged', async () => {
    render(<PreviewPanel />);
    const err = await screen.findByText(/还没有生成/);
    expect(err.textContent).toContain('dogfood-3752-并行检查.txt');
    const tabId = useAppStore.getState().activePreviewTabId;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByText(/还没有生成/).textContent).toContain('dogfood-3752-并行检查.txt'));
    const s = useAppStore.getState();
    expect(s.previewTabs).toHaveLength(1);
    expect(s.activePreviewTabId).toBe(tabId);
    expect(s.previewTabs[0].path).toBe(MISSING);
  });
});
