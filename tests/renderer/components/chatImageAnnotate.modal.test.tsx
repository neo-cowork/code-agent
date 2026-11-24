// @vitest-environment jsdom
// 批注弹窗的拖框：指针事件连发（同一批更新里 down→move→up）时，松手判定必须读最新的框，
// 不能读上一帧 state——否则快速框选的框会被当成误触删掉，发送钮永远禁用。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatImageAnnotateModal } from '../../../src/renderer/components/features/chat/MessageBubble/ChatImageAnnotateModal';
import type { SessionMediaAsset } from '../../../src/shared/utils/sessionMediaAssets';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const asset = {
  assetId: 'a1',
  sessionId: 's1',
  source: 'attachment',
  role: 'input',
  sources: [{ source: 'attachment', role: 'input' }],
  kind: 'image',
  state: 'ready',
  dataUrl: png,
} as unknown as SessionMediaAsset;

beforeEach(() => {
  useAppStore.setState({ language: 'zh' });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200, toJSON: () => ({}),
  } as DOMRect);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ChatImageAnnotateModal 拖框', () => {
  it('同一批更新里快速 down→move→up，框被保留并出现这个框的评论输入', async () => {
    render(<ChatImageAnnotateModal asset={asset} onClose={() => {}} />);
    const overlay = await screen.findByTestId('chat-image-annotate-overlay');

    act(() => {
      fireEvent.pointerDown(overlay, { clientX: 20, clientY: 20, pointerId: 1 });
      fireEvent.pointerMove(overlay, { clientX: 220, clientY: 120, pointerId: 1 });
      fireEvent.pointerUp(overlay, { clientX: 220, clientY: 120, pointerId: 1 });
    });

    expect(screen.getAllByTestId('chat-image-annotate-box')).toHaveLength(1);
    expect(screen.getByText('区域 1')).toBeTruthy();
    expect((screen.getByTestId('chat-image-annotate-send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('太小的框（误触）被丢弃，不产生区域', async () => {
    render(<ChatImageAnnotateModal asset={asset} onClose={() => {}} />);
    const overlay = await screen.findByTestId('chat-image-annotate-overlay');

    act(() => {
      fireEvent.pointerDown(overlay, { clientX: 20, clientY: 20, pointerId: 1 });
      fireEvent.pointerMove(overlay, { clientX: 24, clientY: 23, pointerId: 1 });
      fireEvent.pointerUp(overlay, { clientX: 24, clientY: 23, pointerId: 1 });
    });

    expect(screen.queryAllByTestId('chat-image-annotate-box')).toHaveLength(0);
    expect((screen.getByTestId('chat-image-annotate-send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('读不出来的图给人话错误，不渲染叠层', async () => {
    const broken = { ...asset, dataUrl: undefined, path: undefined, url: undefined, thumbnailUrl: undefined } as unknown as SessionMediaAsset;
    render(<ChatImageAnnotateModal asset={broken} onClose={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toContain('读取不出来');
    expect(screen.queryByTestId('chat-image-annotate-overlay')).toBeNull();
  });

  it('绘制中收到 pointercancel：丢弃进行中的框，不留下比评论多出来的框', async () => {
    render(<ChatImageAnnotateModal asset={asset} onClose={() => {}} />);
    const overlay = await screen.findByTestId('chat-image-annotate-overlay');

    act(() => {
      fireEvent.pointerDown(overlay, { clientX: 20, clientY: 20, pointerId: 1 });
      fireEvent.pointerMove(overlay, { clientX: 30, clientY: 25, pointerId: 1 });
      fireEvent.pointerCancel(overlay, { pointerId: 1 });
    });
    expect(screen.queryAllByTestId('chat-image-annotate-box')).toHaveLength(0);

    act(() => {
      fireEvent.pointerDown(overlay, { clientX: 20, clientY: 20, pointerId: 2 });
      fireEvent.pointerMove(overlay, { clientX: 220, clientY: 120, pointerId: 2 });
      fireEvent.pointerUp(overlay, { clientX: 220, clientY: 120, pointerId: 2 });
    });
    expect(screen.getAllByTestId('chat-image-annotate-box')).toHaveLength(1);
    expect(screen.getByText('区域 1')).toBeTruthy();
  });

  it('输入框正在编辑排队消息时不发批注，给出人话提示', async () => {
    const row = document.createElement('div');
    row.setAttribute('data-editing', 'true');
    document.body.appendChild(row);
    try {
      render(<ChatImageAnnotateModal asset={asset} onClose={() => {}} />);
      const overlay = await screen.findByTestId('chat-image-annotate-overlay');
      act(() => {
        fireEvent.pointerDown(overlay, { clientX: 20, clientY: 20, pointerId: 1 });
        fireEvent.pointerMove(overlay, { clientX: 220, clientY: 120, pointerId: 1 });
        fireEvent.pointerUp(overlay, { clientX: 220, clientY: 120, pointerId: 1 });
      });
      const sent = vi.fn();
      window.addEventListener('browser-annotation:submit', sent);
      fireEvent.click(screen.getByTestId('chat-image-annotate-send'));
      expect((await screen.findByRole('alert')).textContent).toContain('排队消息');
      expect(sent).not.toHaveBeenCalled();
      window.removeEventListener('browser-annotation:submit', sent);
    } finally {
      row.remove();
    }
  });
});
