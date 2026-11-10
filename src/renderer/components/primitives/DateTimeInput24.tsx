import React from 'react';
import { Input } from './Input';
import { TimeInput24 } from './TimeInput24';

/** 选好日期后时间的默认值（与周期任务的默认时间一致）。 */
const DEFAULT_TIME = '09:00';

export interface DateTimeInput24Props {
  /** 本地时间串 yyyy-MM-ddTHH:mm；空串表示还没选 */
  value: string;
  onChange: (value: string) => void;
  dateLabel: string;
  hourLabel: string;
  minuteLabel: string;
  testId: string;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

/** 解析 yyyy-MM-ddTHH:mm；不完整或越界返回 null。 */
function parseValue(value: string): { date: string; time: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59) return null;
  return { date: match[1], time: `${match[2]}:${match[3]}` };
}

/**
 * 24 小时制的「日期 + 时间」：原生日期框（日历弹层，无 AM/PM）+ TimeInput24。
 * 不用 datetime-local：它的显示格式跟系统区域走，页面无法钉成 24 小时。
 */
export const DateTimeInput24: React.FC<DateTimeInput24Props> = ({
  value,
  onChange,
  dateLabel,
  hourLabel,
  minuteLabel,
  testId,
  disabled = false,
  size = 'md',
}) => {
  const parsed = parseValue(value);
  const date = parsed?.date ?? '';
  const time = parsed?.time ?? DEFAULT_TIME;

  return (
    <div data-testid={testId} className="flex flex-wrap items-center gap-1.5">
      <Input
        type="date"
        data-testid={`${testId}-date`}
        aria-label={dateLabel}
        value={date}
        disabled={disabled}
        inputSize={size}
        fullWidth={false}
        className="!w-auto"
        onChange={(event) => {
          const next = event.target.value;
          onChange(/^\d{4}-\d{2}-\d{2}$/.test(next) ? `${next}T${time}` : '');
        }}
      />
      <TimeInput24
        testId={`${testId}-time`}
        value={time}
        disabled={disabled || !date}
        size={size}
        hourLabel={hourLabel}
        minuteLabel={minuteLabel}
        onChange={(nextTime) => onChange(date ? `${date}T${nextTime}` : '')}
      />
    </div>
  );
};
