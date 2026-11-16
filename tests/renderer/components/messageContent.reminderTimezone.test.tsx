// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageContent } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';
import { wrapTicketsAsLinks } from '../../../src/renderer/components/features/chat/MessageBubble/filePathProcessor';
import { zh } from '../../../src/renderer/i18n';

vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh, language: 'zh' }) }));
afterEach(cleanup);

describe('wrapTicketsAsLinks reminder time zones and standards', () => {
  it.each(['(UTC-8)', '(UTC+8)', '(GMT-5)', 'UTF-8', 'ISO-8601', 'SHA-256', 'AES-256', 'RFC-3339'])(
    'keeps %s as plain text', (text) => {
      expect(wrapTicketsAsLinks(text)).toBe(text);
    },
  );

  it('still links JIRA-42 and DSECDCN-1988 alongside ignored prefixes', () => {
    expect(wrapTicketsAsLinks('UTC-8 JIRA-42 GMT-5 DSECDCN-1988 UTF-8'))
      .toBe('UTC-8 [JIRA-42](!ticket) GMT-5 [DSECDCN-1988](!ticket) UTF-8');
  });

  it('preserves code spans, fenced code and existing links', () => {
    const text = '`UTC-8` `JIRA-42`\n```\nJIRA-42\n```\n[JIRA-42](!ticket)';
    expect(wrapTicketsAsLinks(text)).toBe(text);
  });
});

describe('MessageContent reminder time zones', () => {
  it('renders 2026-11-16 09:00 (UTC-8) without a ticket copy button or anchor', () => {
    const text = '2026-11-16 09:00 (UTC-8)';
    const view = render(<MessageContent content={text} isUser={false} />);
    expect(view.container.textContent).toContain(text);
    expect(view.container.querySelector('button[title^="点击复制"]')).toBeNull();
    expect(view.container.querySelector('a')).toBeNull();
  });
});
