// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../../../src/renderer/components/ErrorBoundary';
import { ChatTraceFallback } from '../../../src/renderer/components/features/chat/ChatTraceFallback';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const { chunkLoadError } = vi.hoisted(() => ({
  chunkLoadError: new Error('Unable to preload CSS for http://127.0.0.1:53695/assets/MarkdownCore-BorAY7qD.css'),
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/MarkdownCore', () => {
  return Promise.reject(chunkLoadError);
});

const { MessageContent } = await import(
  '../../../src/renderer/components/features/chat/MessageBubble/MessageContent'
);

describe('MessageContent when MarkdownCore chunk import rejects', () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ language: 'zh' });
    vi.restoreAllMocks();
  });

  it('degrades to sanitized plain text without tripping ErrorBoundary (zh & en)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const zhSentence = 'Neo 暂时没能完成这次请求，请稍后再试。';
    useAppStore.setState({ language: 'zh' });
    const { container, queryByRole, rerender } = render(
      <ErrorBoundary fallback={<ChatTraceFallback />}>
        <MessageContent
          content={`${zhSentence} <span>[重试操作](!send)</span>`}
          isUser={false}
          messageId="assistant-fail-zh"
        />
      </ErrorBoundary>,
    );

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        '[MarkdownCore] chunk load failed, using plain text',
        expect.any(Error),
      );
    });
    const loggedError = warnSpy.mock.calls[0]?.[1] as Error & { cause?: unknown };
    expect(
      loggedError === chunkLoadError || loggedError?.cause === chunkLoadError,
    ).toBe(true);

    expect(container.textContent).toContain(zhSentence);
    expect(container.textContent).toContain('重试操作');
    expect(container.textContent).not.toContain('!send');
    expect(container.textContent).not.toContain('<span>');
    expect(queryByRole('alert')).toBeNull();
    expect(container.textContent).not.toContain('这个会话的消息暂时显示不出来');
    expect(errorSpy).not.toHaveBeenCalledWith(
      '[ErrorBoundary] Caught error:',
      expect.anything(),
      expect.anything(),
    );

    const enSentence = 'Neo could not complete the request; please try again in a moment.';
    useAppStore.setState({ language: 'en' });
    rerender(
      <ErrorBoundary fallback={<ChatTraceFallback />}>
        <MessageContent
          content={enSentence}
          isUser={false}
          messageId="assistant-fail-en"
        />
      </ErrorBoundary>,
    );

    expect(container.textContent).toContain(enSentence);
    expect(queryByRole('alert')).toBeNull();
    expect(container.textContent).not.toContain('This conversation could not be displayed');
  });

  it('also keeps streaming blocks in plain text without tripping ErrorBoundary', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container, queryByRole } = render(
      <ErrorBoundary fallback={<ChatTraceFallback />}>
        <MessageContent
          content={'## Weekly Report\n\nNeo could not complete the request; please try again in a moment.'}
          isUser={false}
          isStreaming
          messageId="assistant-fail-stream"
        />
      </ErrorBoundary>,
    );

    await waitFor(() => {
      expect(container.textContent).toContain(
        'Neo could not complete the request; please try again in a moment.',
      );
    });
    expect(queryByRole('alert')).toBeNull();
  });
});
