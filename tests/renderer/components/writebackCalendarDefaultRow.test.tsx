// @vitest-environment jsdom
// 建日程的批准卡（N-CALENDAR-ONE-PERMISSION-EVENTKIT 真机第二轮）：日历行显示实际写入的默认日历名；拿不到就不显示，不写「无」。
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { WritebackFieldsView } from '../../../src/renderer/components/PermissionDialog/WritebackFields';

afterEach(cleanup);

it('shows the real default calendar name, and drops the row instead of「无」when it is unknown', () => {
  const view = render(<WritebackFieldsView tool="calendar_create_event" args={{ calendar: '家庭', title: '评审', start_ms: 1 }} />);
  expect(screen.getByTestId('writeback-view-calendar').textContent).toBe('家庭');
  view.unmount();
  render(<WritebackFieldsView tool="calendar_create_event" args={{ title: '评审', start_ms: 1 }} />);
  expect(screen.queryByTestId('writeback-view-calendar')).toBeNull();
  expect(screen.getByTestId('writeback-view-title').textContent).toBe('评审');
});
