// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CronReviewDigest } from '../../../src/renderer/components/features/cron/CronReviewDigest';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
});

describe('review summary expansion', () => {
  for (const [language, locale] of [['zh', zh], ['en', en]] as const) {
    it(`${language}: clamps to two lines and expands the complete persisted summary independently of artifacts`, () => {
      useAppStore.setState({ language });
      const full = '完整结果。'.repeat(300) + '\n最后一句也能读到。';
      render(<CronReviewDigest digest={{ artifactCount: 0, summaryLine: '预览。…', summaryText: full }} />);
      const summary = screen.getByTestId('automation-review-summary');
      const toggle = screen.getByRole('button', { name: locale.cronCenter.inboxDigestExpand });
      expect(summary.textContent).toBe(`· ${full}`);
      expect(summary.className).toContain('line-clamp-2');
      expect(summary.className).toContain('break-words');
      expect(summary.className).not.toContain('truncate');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(toggle.textContent).toBe(locale.cronCenter.inboxDigestCollapse);
      expect(summary.className).not.toContain('line-clamp');
      expect(summary.textContent).toContain('最后一句也能读到。');
      fireEvent.click(toggle);
      expect(summary.className).toContain('line-clamp-2');
    });
  }

  it('allows existing records to expand their stored preview and hides urgency metadata', () => {
    render(<CronReviewDigest digest={{ artifactCount: 0, summaryLine: 'urgency: fyi\n已有摘要。' }} />);
    expect(screen.getByTestId('automation-review-summary').textContent).toBe('· 已有摘要。');
    fireEvent.click(screen.getByTestId('automation-review-summary-toggle'));
    expect(screen.getByTestId('automation-review-summary').className).not.toContain('line-clamp');
  });
});
