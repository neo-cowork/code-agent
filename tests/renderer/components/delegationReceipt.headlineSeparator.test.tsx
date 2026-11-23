// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import type { DelegationPresentation } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/delegationPresentation';

let language: 'zh' | 'en' = 'zh';
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: language === 'zh' ? zh : en }) }));

const openPreview = vi.fn();
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(
    (selector: (state: {
      openPreview: typeof openPreview;
      language: 'zh' | 'en';
      pendingPermissionRequest: null;
      pendingPermissionSessionId: null;
      queuedPermissionRequests: Record<string, never>;
      processingSessionIds: Set<string>;
    }) => unknown) => selector({
      openPreview,
      language,
      pendingPermissionRequest: null,
      pendingPermissionSessionId: null,
      queuedPermissionRequests: {},
      processingSessionIds: new Set(),
    }),
    { getState: () => ({ language }) },
  ),
}));

import { DelegationHeader, DelegationReceipt } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/DelegationReceipt';

const STATES = ['working', 'completed', 'failed', 'cancelled'] as const;

const STATUS = {
  zh: { working: '正在处理', completed: '已完成', failed: '没有完成', cancelled: '已取消' },
  en: { working: 'is working', completed: 'finished', failed: "didn't finish", cancelled: 'was cancelled' },
} as const;

function presentation(state: typeof STATES[number], title: string): DelegationPresentation {
  return { state, title, outputs: [], activityIds: [] };
}

function renderHeadline(state: typeof STATES[number], title: string) {
  const source = presentation(state, title);
  const view = render(
    <>
      <DelegationHeader presentation={source} />
      <DelegationReceipt presentation={source} />
    </>,
  );
  return { source, headline: screen.getByTestId('delegation-headline'), view };
}

afterEach(() => {
  cleanup();
  language = 'zh';
});

describe('delegation headline separator', () => {
  it.each(STATES)('zh %s keeps the title and the status word apart', (state) => {
    language = 'zh';
    const title = '打开 example.net 并读取页面标题';
    const { headline } = renderHeadline(state, title);
    const status = STATUS.zh[state];
    expect(screen.getAllByTestId('delegation-headline')).toHaveLength(1);
    expect(headline.textContent).toBe(`${title} · ${status}`);
    expect(headline.getAttribute('title')).toBe(`${title} · ${status}`);
    expect(headline.querySelector('.font-semibold')?.textContent).toBe(title);
    expect(headline.querySelector('.text-zinc-500')?.textContent).toBe(` · ${status}`);
  });

  it.each(STATES)('en %s keeps the title and the status word apart', (state) => {
    language = 'en';
    const title = 'Open example.net and read the page title';
    const { headline } = renderHeadline(state, title);
    const status = STATUS.en[state];
    expect(screen.getAllByTestId('delegation-headline')).toHaveLength(1);
    expect(headline.textContent).toBe(`${title} · ${status}`);
    expect(headline.getAttribute('title')).toBe(`${title} · ${status}`);
    expect(headline.querySelector('.font-semibold')?.textContent).toBe(title);
    expect(headline.querySelector('.text-zinc-500')?.textContent).toBe(` · ${status}`);
  });

  it('strips a trailing Chinese period only from the displayed headline', () => {
    language = 'zh';
    const title = '打开 example.net 并读取页面标题。';
    const { source, headline } = renderHeadline('failed', title);
    expect(source.title).toBe(title);
    expect(headline.textContent).toBe('打开 example.net 并读取页面标题 · 没有完成');
    expect(headline.getAttribute('title')).toBe('打开 example.net 并读取页面标题 · 没有完成');
    expect(headline.querySelector('.font-semibold')?.getAttribute('title')).toBe('打开 example.net 并读取页面标题');
    expect(headline.textContent).not.toContain('。 ·');
  });

  it('strips a trailing question mark only from the displayed headline', () => {
    language = 'en';
    const title = 'Open example.net and read the page title?';
    const { source, headline } = renderHeadline('failed', title);
    expect(source.title).toBe(title);
    expect(headline.textContent).toBe("Open example.net and read the page title · didn't finish");
    expect(headline.getAttribute('title')).toBe("Open example.net and read the page title · didn't finish");
    expect(headline.querySelector('.font-semibold')?.getAttribute('title')).toBe('Open example.net and read the page title');
    expect(headline.textContent).not.toContain('? ·');
  });

  it('keeps a long title inside one headline element', () => {
    language = 'zh';
    const title = '打开 example.net 并读取页面标题，把浏览器标签上的原文记下来，不要改写成摘要'.repeat(4);
    const { headline } = renderHeadline('failed', title);
    expect(screen.getAllByTestId('delegation-headline')).toHaveLength(1);
    expect(headline.className).toContain('truncate');
    expect(headline.textContent).toBe(`${title} · 没有完成`);
    expect(headline.querySelectorAll('.font-semibold')).toHaveLength(1);
  });
});
