// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MessageContent } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';

afterEach(cleanup);

async function waitForMarkdown(container: HTMLElement) {
  // A paragraph only exists after lazy MarkdownCore resolves, not in Suspense fallback.
  await waitFor(() => expect(container.querySelector('p')).not.toBeNull());
}

describe('MessageContent currency dollars', () => {
  it.each([
    '收入 $15,550，日均 $3,110',
    'West $4,750',
    '$6,400 到 $4,750',
    'Revenue $15,550, average $3,110/day; West $4,750',
  ])('renders amounts verbatim with zero katex nodes: %s', async (content) => {
    const { container } = render(<MessageContent content={content} isUser={false} />);
    await waitForMarkdown(container);
    expect(container.textContent).toBe(content);
    expect(container.querySelectorAll('.katex')).toHaveLength(0);
  });

  it('still renders single-dollar, inline double-dollar and block formulas', async () => {
    const { container } = render(<MessageContent
      content={'Formula $x^2$ and $\\bar{x}$. Inline $$E=mc^2$$.\n\n$$\nE=mc^2\n$$'}
      isUser={false}
    />);
    await waitForMarkdown(container);
    expect(container.querySelectorAll('.katex')).toHaveLength(4);
    expect(container.querySelectorAll('.katex-display')).toHaveLength(1);
  });

  it('keeps currency in inline and fenced code untouched', async () => {
    const { container } = render(<MessageContent
      content={'`$5 and $6`\n\n```text\n$5 and $6\n```'} isUser={false}
    />);
    await waitForMarkdown(container);
    expect(container.querySelector('p code')?.textContent).toBe('$5 and $6');
    expect(container.querySelector('pre')?.textContent).toContain('$5 and $6');
    expect(container.querySelectorAll('.katex')).toHaveLength(0);
  });

  it.each(['', '**Sales** '])('keeps streaming and saved amounts identical (markdown prefix %j)', async (prefix) => {
    const partial = `${prefix}收入 $15,550，日均 $3,110`;
    const final = `${partial}；West $4,750`;
    const { container, rerender } = render(<MessageContent content={partial} isUser={false} isStreaming />);
    // Prefix forces the streaming MarkdownRenderer path as well as the plain streaming path.
    if (prefix) await waitForMarkdown(container);
    expect(container.textContent).toContain('收入 $15,550，日均 $3,110');
    const streamingPartial = container.textContent;
    expect(container.querySelectorAll('.katex')).toHaveLength(0);
    rerender(<MessageContent content={partial} isUser={false} />);
    await waitForMarkdown(container);
    const savedPartial = container.textContent;
    expect(savedPartial).toBe(streamingPartial);
    expect(container.querySelectorAll('.katex')).toHaveLength(0);
    rerender(<MessageContent content={final} isUser={false} isStreaming />);
    await waitFor(() => expect(container.textContent).toContain('；West $4,750'));
    const streamingText = container.textContent;
    expect(container.querySelectorAll('.katex')).toHaveLength(0);
    rerender(<MessageContent content={final} isUser={false} />);
    await waitForMarkdown(container);
    expect(container.textContent).toBe(streamingText);
    expect(container.querySelectorAll('.katex')).toHaveLength(0);
  });
});
