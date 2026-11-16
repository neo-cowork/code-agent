// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { zh } from '../../../src/renderer/i18n/zh';
import type { CalendarSettingResult } from '../../../src/shared/contract/envAssist';

const state = vi.hoisted(() => ({
  enable: { on: false, reason: 'denied' } as CalendarSettingResult,
  recheck: { on: false } as CalendarSettingResult,
  invoke: vi.fn(),
}));
state.invoke.mockImplementation(async (_domain: string, action: string) =>
  action === 'enableSettingGrant' ? state.enable : action === 'recheckSettingGrant' ? state.recheck : undefined);

vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invokeDomain: state.invoke } }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));

import { MeetingCalendarReminderToggle } from '../../../src/renderer/components/features/settings/sections/MeetingCalendarReminderToggle';

afterEach(() => { cleanup(); state.invoke.mockClear(); state.recheck = { on: false }; });

const calls = (action: string) => state.invoke.mock.calls.filter((c) => c[1] === action);

describe('会前提醒开关', () => {
  it('打开只发请求，渲染层从不把设置写成开；被拒就停在关并说明去哪里允许', async () => {
    state.enable = { on: false, reason: 'denied', opened: true };
    render(<MeetingCalendarReminderToggle />);
    const sw = await screen.findByRole('switch', { name: '会前提醒我记这场会' });
    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByText(/系统设置 → 隐私与安全性 → 日历/)).toBeTruthy());
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(calls('enableSettingGrant')).toHaveLength(1);
    expect(calls('set')).toHaveLength(0);
  });

  it('只写访问：提示改成「完全访问」', async () => {
    state.enable = { on: false, reason: 'write_only', opened: true };
    render(<MeetingCalendarReminderToggle />);
    fireEvent.click(await screen.findByRole('switch', { name: '会前提醒我记这场会' }));
    await waitFor(() => expect(screen.getByText(/改成「完全访问」/)).toBeTruthy());
  });

  it('宿主确认授权：开关打开', async () => {
    state.enable = { on: true };
    render(<MeetingCalendarReminderToggle />);
    const sw = await screen.findByRole('switch', { name: '会前提醒我记这场会' });
    fireEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    expect(calls('set')).toHaveLength(0);
  });

  it('关掉：直接存关，不走授权', async () => {
    state.recheck = { on: true };
    render(<MeetingCalendarReminderToggle />);
    const sw = await screen.findByRole('switch', { name: '会前提醒我记这场会' });
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('false'));
    expect(calls('set').map((c) => c[2])).toEqual([{ meeting: { calendarReminder: false } }]);
    expect(calls('enableSettingGrant')).toHaveLength(0);
  });

  it('授权已失效：开关显示关，提示点开关重新允许；点开关照常走 enableSettingGrant', async () => {
    state.recheck = { on: false, reason: 'revoked' };
    state.enable = { on: true };
    render(<MeetingCalendarReminderToggle />);
    const sw = await screen.findByRole('switch', { name: '会前提醒我记这场会' });
    await waitFor(() => expect(screen.getByText('日历权限已失效，点开关重新允许。')).toBeTruthy());
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    expect(calls('enableSettingGrant')).toHaveLength(1);
  });

  it('入口在屏幕记忆页「采集与注入」一组，不在默认折叠的诊断区里', () => {
    const src = readFileSync('src/renderer/components/features/settings/tabs/ScreenMemorySettings.tsx', 'utf8');
    const toggle = src.indexOf('<MeetingCalendarReminderToggle');
    expect(toggle).toBeGreaterThan(src.indexOf('<SettingsSection title={screenMemoryText.captureSection.title}>'));
    expect(toggle).toBeLessThan(src.indexOf('<SettingsDetails'));
    expect(src.split('<MeetingCalendarReminderToggle').length).toBe(2);
  });

  it('挂载和窗口重新聚焦时被动复查；宿主补开后开关跟着亮', async () => {
    render(<MeetingCalendarReminderToggle />);
    const sw = await screen.findByRole('switch', { name: '会前提醒我记这场会' });
    await waitFor(() => expect(calls('recheckSettingGrant')).toHaveLength(1));
    state.recheck = { on: true };
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    expect(calls('recheckSettingGrant')).toHaveLength(2);
  });
});
