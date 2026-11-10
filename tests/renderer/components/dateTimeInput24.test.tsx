// @vitest-environment jsdom

import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateTimeInput24 } from '../../../src/renderer/components/primitives';

function stubTwelveHourLocale(): void {
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    locale: 'en-US',
    calendar: 'gregory',
    numberingSystem: 'latn',
    timeZone: 'America/Los_Angeles',
    hourCycle: 'h12',
    hour12: true,
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderHarness(initial = '') {
  const onChange = vi.fn();
  const Harness = () => {
    const [value, setValue] = useState(initial);
    return (
      <DateTimeInput24
        value={value}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
        dateLabel="Date"
        hourLabel="Hour"
        minuteLabel="Minute"
        testId="dt"
      />
    );
  };
  const view = render(<Harness />);
  return { onChange, ...view };
}

describe('DateTimeInput24', () => {
  it('en-US h12 区域：日期框为空、时间是 24 小时下拉，无 AM/PM、无 datetime-local', () => {
    stubTwelveHourLocale();
    const { container } = renderHarness();
    expect(new Intl.DateTimeFormat().resolvedOptions().hourCycle).toBe('h12');
    expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
    expect((screen.getByTestId('dt-date') as HTMLInputElement).value).toBe('');
    expect(container.querySelectorAll('select').length).toBe(2);
    expect(document.body.textContent).not.toMatch(/AM|PM/);
  });

  it('选日期后时间默认 09:00；改小时分钟输出 yyyy-MM-ddTHH:mm', () => {
    const { onChange } = renderHarness();
    fireEvent.change(screen.getByTestId('dt-date'), { target: { value: '2026-11-10' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-11-10T09:00');
    fireEvent.change(screen.getByTestId('dt-time-hour'), { target: { value: '15' } });
    fireEvent.change(screen.getByTestId('dt-time-minute'), { target: { value: '30' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-11-10T15:30');
  });

  it.each([':37', ':37.1', ':37.12', ':37.123', ':00.000'])('保留 %s：挂载不回写，改日期、小时、分钟保留精度', (suffix) => {
    const { onChange } = renderHarness(`2026-11-10T23:45${suffix}`);
    expect((screen.getByTestId('dt-date') as HTMLInputElement).value).toBe('2026-11-10');
    expect((screen.getByTestId('dt-time-hour') as HTMLSelectElement).value).toBe('23');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('dt-date'), { target: { value: '2026-11-12' } });
    expect(onChange).toHaveBeenLastCalledWith(`2026-11-12T23:45${suffix}`);
    fireEvent.change(screen.getByTestId('dt-time-hour'), { target: { value: '15' } });
    fireEvent.change(screen.getByTestId('dt-time-minute'), { target: { value: '30' } });
    expect(onChange).toHaveBeenLastCalledWith(`2026-11-12T15:30${suffix}`);
  });

  it.each([':60', ':37.', ':37.1234'])('拒绝非法秒后缀 %s', (suffix) => {
    renderHarness(`2026-11-10T15:30${suffix}`);
    expect((screen.getByTestId('dt-date') as HTMLInputElement).value).toBe('');
  });

  it('清空日期 → 输出空串；不完整/非法值显示为空日期', () => {
    const { onChange, unmount } = renderHarness('2026-11-10T15:00');
    expect((screen.getByTestId('dt-date') as HTMLInputElement).value).toBe('2026-11-10');
    expect((screen.getByTestId('dt-time-hour') as HTMLSelectElement).value).toBe('15');
    fireEvent.change(screen.getByTestId('dt-date'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('');
    unmount();
    renderHarness('2026-11-10');
    expect((screen.getByTestId('dt-date') as HTMLInputElement).value).toBe('');
  });
});
