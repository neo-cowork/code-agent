import React from 'react';
import { Input } from './Input';
import { TimeInput24 } from './TimeInput24';

/** 选好日期后时间的默认值（与周期任务的默认时间一致）。 */
const DEFAULT_TIME = '09:00';

export interface DateTimeInput24Props {
  /** 本地时间串 yyyy-MM-ddTHH:mm，可带 :ss(.SSS)；空串表示还没选 */
  value: string;
  onChange: (value: string) => void;
  dateLabel: string;
  hourLabel: string;
  minuteLabel: string;
  testId: string;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

/** 秒和毫秒不显示，编辑日期或分钟时原样保留。 */
function parseValue(value: string): { date: string; time: string; suffix: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(:(\d{2})(?:\.\d{1,3})?)?$/.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[5] ?? 0) > 59) return null;
  return { date: match[1], time: `${match[2]}:${match[3]}`, suffix: match[4] ?? '' };
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
  const suffix = parsed?.suffix ?? '';

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
          onChange(/^\d{4}-\d{2}-\d{2}$/.test(next) ? `${next}T${time}${suffix}` : '');
        }}
      />
      <TimeInput24
        testId={`${testId}-time`}
        value={time}
        disabled={disabled || !date}
        size={size}
        hourLabel={hourLabel}
        minuteLabel={minuteLabel}
        onChange={(nextTime) => onChange(date ? `${date}T${nextTime}${suffix}` : '')}
      />
    </div>
  );
};
