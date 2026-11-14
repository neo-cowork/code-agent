// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PermissionRequest } from '../../../src/shared/contract';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { UserRequestQuote } from '../../../src/renderer/components/PermissionDialog/UserRequestQuote';

type Details = PermissionRequest['details'];
describe('UserRequestQuote', () => {
  it.each([['zh', zh], ['en', en]] as const)('%s quote, truncation ellipsis, scheduled origin, nothing', (_l, m) => {
    const labels = m.decisionCard.permission;
    const view = render(<UserRequestQuote labels={labels} details={{ userRequest: { text: '加日程', truncated: false } } as Details} />);
    expect(screen.getByTestId('user-request-quote').textContent).toBe(labels.userRequestQuote.replace('{text}', '加日程'));
    view.rerender(<UserRequestQuote labels={labels} details={{ userRequest: { text: '很长', truncated: true } } as Details} />);
    expect(screen.getByTestId('user-request-quote').textContent).toContain('很长…');
    view.rerender(<UserRequestQuote labels={labels} details={{ startedByAutomation: true, purpose: '每日简报' } as Details} />);
    expect(screen.queryByTestId('user-request-quote')).toBeNull();
    expect(screen.getByTestId('scheduled-task-origin').textContent).toBe(labels.startedByScheduledTask.replace('{name}', '每日简报'));
    view.rerender(<UserRequestQuote labels={labels} details={{} as Details} />);
    expect(screen.queryByTestId('scheduled-task-origin')).toBeNull();
  });
});
