// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import {
  InlineComposerChip,
  type InlineChipView,
} from '../../../src/renderer/components/features/chat/ChatInput/InlineComposerChip';
import { zh } from '../../../src/renderer/i18n/zh';

const THUMB = 'data:image/png;base64,iVBORw0KGgo=';
const chip = (over: Partial<InlineChipView> = {}): InlineChipView => ({
  key: 'file:a', kind: 'file', id: 'a', label: 'photo.png', category: 'image', thumbnail: THUMB, ...over,
});
const imgOf = (c: HTMLElement) => c.querySelector('[data-inline-chip="file"] img');
const svgOf = (c: HTMLElement) => c.querySelector('[data-inline-chip="file"] svg:not([class*="lucide-x"])');

afterEach(cleanup);

describe('InlineComposerChip thumbnail', () => {
  it('image + thumbnail renders img', () => {
    const { container } = render(<InlineComposerChip chip={chip()} onRemove={vi.fn()} />);
    const img = imgOf(container) as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe(THUMB);
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('aria-hidden')).toBe('true');
  });

  it('image without thumbnail falls back to icon', () => {
    const { container } = render(<InlineComposerChip chip={chip({ thumbnail: undefined })} onRemove={vi.fn()} />);
    expect(imgOf(container)).toBeNull();
    expect(svgOf(container)).not.toBeNull();
  });

  it('non-image keeps icon even with thumbnail', () => {
    const { container } = render(<InlineComposerChip chip={chip({ category: 'document' })} onRemove={vi.fn()} />);
    expect(imgOf(container)).toBeNull();
    expect(svgOf(container)).not.toBeNull();
  });

  it('img load error falls back to icon', () => {
    const { container } = render(<InlineComposerChip chip={chip()} onRemove={vi.fn()} />);
    fireEvent.error(imgOf(container) as Element);
    expect(imgOf(container)).toBeNull();
    expect(svgOf(container)).not.toBeNull();
  });

  it('remove button, Delete key and aria are unchanged', () => {
    const onRemove = vi.fn();
    const c = chip();
    render(<InlineComposerChip chip={c} onRemove={onRemove} />);
    const group = screen.getByRole('group', { name: 'photo.png' });
    fireEvent.click(screen.getByRole('button', { name: zh.chatInput.attachRemoveAria.replace('{name}', 'photo.png') }));
    expect(onRemove).toHaveBeenCalledWith(c);
    fireEvent.keyDown(group, { key: 'Delete' });
    expect(onRemove).toHaveBeenCalledTimes(2);
  });
});
