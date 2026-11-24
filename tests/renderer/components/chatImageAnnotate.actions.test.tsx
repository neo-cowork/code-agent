// @vitest-environment jsdom
// 聊天图片批注入口：只有就绪、可渲染的图片有「批注」；视频/音频/文档/失败/生成中都没有。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  getMediaAssetAvailableActions,
  MediaAssetActionBar,
} from '../../../src/renderer/components/features/chat/MessageBubble/MediaAssetControls';
import { AttachmentDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview';
import type { SessionMediaAsset } from '../../../src/shared/utils/sessionMediaAssets';
import type { MessageAttachment } from '../../../src/shared/contract/message';
import { useAppStore } from '../../../src/renderer/stores/appStore';

vi.mock('../../../src/renderer/utils/platform', () => ({
  copyPathToClipboard: vi.fn(),
  isWebMode: () => true,
  isNativeCommandRuntimeAvailable: () => false,
}));

const baseAsset = {
  assetId: 'a1',
  sessionId: 's1',
  turnId: 't1',
  messageId: 'm1',
  source: 'markdown',
  role: 'output',
  sources: [{ source: 'markdown', role: 'output' }],
  kind: 'image',
  state: 'ready',
  path: '/tmp/x/pic.png',
  filename: 'pic.png',
} as unknown as SessionMediaAsset;

const withAsset = (patch: Partial<SessionMediaAsset>): SessionMediaAsset => ({ ...baseAsset, ...patch });

beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
});
afterEach(cleanup);

describe('getMediaAssetAvailableActions · annotate', () => {
  it('就绪图片有 annotate', () => {
    expect(getMediaAssetAvailableActions(baseAsset)).toContain('annotate');
  });

  it('视频 / 音频没有 annotate', () => {
    expect(getMediaAssetAvailableActions(withAsset({ kind: 'video' }))).not.toContain('annotate');
    expect(getMediaAssetAvailableActions(withAsset({ kind: 'audio' }))).not.toContain('annotate');
  });

  it('失败 / 生成中的图片没有 annotate', () => {
    expect(getMediaAssetAvailableActions(withAsset({ state: 'failed' }))).not.toContain('annotate');
    expect(getMediaAssetAvailableActions(withAsset({ state: 'pending' }))).not.toContain('annotate');
  });

  it('没有可渲染来源的图片没有 annotate', () => {
    const noSource = withAsset({ path: undefined, url: undefined, dataUrl: undefined, thumbnailUrl: undefined });
    expect(getMediaAssetAvailableActions(noSource)).not.toContain('annotate');
  });
});

describe('MediaAssetActionBar · 批注按钮', () => {
  it('图片显示批注按钮，视频与失败图片不显示', () => {
    const { rerender } = render(<MediaAssetActionBar asset={baseAsset} compact />);
    expect(screen.queryAllByTestId('media-asset-annotate')).toHaveLength(1);

    rerender(<MediaAssetActionBar asset={withAsset({ kind: 'video' })} compact />);
    expect(screen.queryAllByTestId('media-asset-annotate')).toHaveLength(0);

    rerender(<MediaAssetActionBar asset={withAsset({ state: 'failed' })} compact />);
    expect(screen.queryAllByTestId('media-asset-annotate')).toHaveLength(0);
  });
});

describe('AttachmentPreview · 批注入口', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const render1 = (attachment: MessageAttachment) => render(<AttachmentDisplay attachments={[attachment]} />);

  it('用户上传的图片附件有批注入口', () => {
    render1({ id: 'att-1', type: 'image', category: 'image', name: 'a.png', size: 70, mimeType: 'image/png', data: png } as MessageAttachment);
    expect(screen.queryAllByTestId('media-asset-annotate')).toHaveLength(1);
  });

  it('PDF / Excel 附件没有批注入口', () => {
    render1({ id: 'att-2', type: 'file', category: 'pdf', name: 'a.pdf', size: 10, mimeType: 'application/pdf', path: '/tmp/a.pdf' } as MessageAttachment);
    render1({ id: 'att-3', type: 'file', category: 'excel', name: 'a.xlsx', size: 10, mimeType: 'application/vnd.ms-excel', path: '/tmp/a.xlsx' } as MessageAttachment);
    expect(screen.queryAllByTestId('media-asset-annotate')).toHaveLength(0);
  });

  it('窗口截图卡片（appshot）没有批注入口', () => {
    render1({ id: 'appshot-r1', type: 'image', category: 'image', name: 'x 截图.png', size: 70, mimeType: 'image/png', data: png, appshot: { appName: 'x', textSource: 'none' } } as MessageAttachment);
    expect(screen.queryAllByTestId('media-asset-annotate')).toHaveLength(0);
  });
});
