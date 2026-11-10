import React, { useEffect, useRef, useState } from 'react';
import { Input } from '../../primitives/Input';
import { Select } from '../../primitives/Select';

interface CronDurationUnit {
  value: string;
  label: string;
  milliseconds: number;
}

interface CronDurationFieldProps {
  label: string;
  value: string;
  unitLabels: Record<'seconds' | 'minutes' | 'hours', string>;
  maxUnit: 'minutes' | 'hours';
  onChange: (value: string) => void;
  placeholder: string;
  hint?: string;
  invalidMessage: string;
  testId: string;
}

function parseMilliseconds(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && Number.isSafeInteger(parsed) ? parsed : undefined;
}

function pickDisplayUnit(milliseconds: number | undefined, units: CronDurationUnit[]): CronDurationUnit {
  if (milliseconds == null || milliseconds <= 0) return units[0];
  return [...units].reverse().find((unit) => milliseconds % unit.milliseconds === 0) ?? units[0];
}

function formatValue(milliseconds: number | undefined, unit: CronDurationUnit): string {
  if (milliseconds == null) return '';
  return String(milliseconds / unit.milliseconds);
}

export const CronDurationField: React.FC<CronDurationFieldProps> = ({
  label,
  value,
  unitLabels,
  maxUnit,
  onChange,
  placeholder,
  hint,
  invalidMessage,
  testId,
}) => {
  const units: CronDurationUnit[] = [
    { value: 'seconds', label: unitLabels.seconds, milliseconds: 1_000 },
    { value: 'minutes', label: unitLabels.minutes, milliseconds: 60_000 },
    ...(maxUnit === 'hours' ? [{ value: 'hours', label: unitLabels.hours, milliseconds: 3_600_000 }] : []),
  ];
  const [unit, setUnit] = useState(() => pickDisplayUnit(parseMilliseconds(value), units));
  const [inputValue, setInputValue] = useState(() => formatValue(parseMilliseconds(value), pickDisplayUnit(parseMilliseconds(value), units)));
  const [error, setError] = useState<string>();
  const lastValueRef = useRef(value);

  useEffect(() => {
    if (value === lastValueRef.current) return;
    lastValueRef.current = value;
    const milliseconds = parseMilliseconds(value);
    const nextUnit = pickDisplayUnit(milliseconds, units);
    setUnit(nextUnit);
    setInputValue(formatValue(milliseconds, nextUnit));
    setError(undefined);
  }, [units, value]);

  const commitInput = (nextInput: string, nextUnit: CronDurationUnit) => {
    setInputValue(nextInput);
    if (!nextInput.trim()) {
      lastValueRef.current = '';
      setError(undefined);
      onChange('');
      return;
    }

    const parsed = Number(nextInput);
    const milliseconds = parsed * nextUnit.milliseconds;
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isSafeInteger(Math.round(milliseconds))) {
      setError(invalidMessage);
      return;
    }

    const roundedMilliseconds = Math.round(milliseconds);
    lastValueRef.current = String(roundedMilliseconds);
    setError(undefined);
    onChange(String(roundedMilliseconds));
  };

  return (
    <div>
      <label className="mb-1 block text-sm text-zinc-400" htmlFor={`${testId}-input`}>
        {label}
      </label>
      <div className="grid grid-cols-[minmax(96px,1fr)_88px] gap-2">
        <Input
          id={`${testId}-input`}
          data-testid={`${testId}-input`}
          type="text"
          inputMode="decimal"
          className="!px-2"
          value={inputValue}
          onChange={(event) => commitInput(event.target.value, unit)}
          placeholder={placeholder}
          aria-invalid={!!error}
          aria-describedby={error ? `${testId}-error` : hint ? `${testId}-hint` : undefined}
        />
        <Select
          id={`${testId}-unit`}
          data-testid={`${testId}-unit`}
          value={unit.value}
          aria-label={`${label} unit`}
          options={units}
          onChange={(event) => {
            const nextUnit = units.find((candidate) => candidate.value === event.target.value) ?? units[0];
            setUnit(nextUnit);
            if (inputValue.trim()) commitInput(inputValue, nextUnit);
          }}
        />
      </div>
      {error ? (
        <p id={`${testId}-error`} className="mt-1 text-xs text-badge-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${testId}-hint`} className="mt-1 text-xs text-zinc-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
};
