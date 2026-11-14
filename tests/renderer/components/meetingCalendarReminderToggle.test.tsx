// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { zh } from '../../../src/renderer/i18n/zh';

const state = vi.hoisted(() => ({
  invoke: vi.fn(async (_domain: string, action: string, _payload?: { meeting: { calendarReminder: boolean } }) => (action === 'get' ? { meeting: { calendarReminder: false } } : undefined)),
  access: 'denied' as 'granted' | 'denied',
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invokeDomain: state.invoke } }));
vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  requestCalendarAccess: vi.fn(async () => ({ access: state.access })),
}));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));

import { MeetingCalendarReminderToggle } from '../../../src/renderer/components/features/settings/sections/MeetingCalendarReminderToggle';

afterEach(() => { cleanup(); state.invoke.mockClear(); });

describe('会前提醒开关', () => {
  it('打开：先存开关再要日历授权；被拒就退回关，并告诉用户去哪里允许', async () => {
    state.access = 'denied';
    render(<MeetingCalendarReminderToggle />);
    fireEvent.click(await screen.findByRole('switch', { name: '会前提醒我记这场会' }));
    await waitFor(() => expect(screen.getByText(/系统设置 → 隐私与安全性 → 日历/)).toBeTruthy());
    const sets = state.invoke.mock.calls.filter((c) => c[1] === 'set').map((c) => c[2]?.meeting.calendarReminder);
    expect(sets).toEqual([true, false]);
  });

  it('授权通过：开关保持打开', async () => {
    state.access = 'granted';
    render(<MeetingCalendarReminderToggle />);
    const sw = await screen.findByRole('switch', { name: '会前提醒我记这场会' });
    fireEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    const sets = state.invoke.mock.calls.filter((c) => c[1] === 'set');
    expect(sets).toHaveLength(1);
  });
});
