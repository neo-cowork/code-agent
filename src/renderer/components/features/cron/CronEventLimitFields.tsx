// 事件自动化的两项可选限额：一句话筛选 + 每小时最多运行次数（三种事件源共用）。
import React from 'react';
import { CRON_EVENT_TRIGGER } from '@shared/constants';
import { FormField } from '../../composites/FormField';
import { Input } from '../../primitives/Input';
import { useI18n } from '../../../hooks/useI18n';

interface CronEventLimitFieldsProps {
  prefilter: string;
  maxRunsPerHour: string;
  onPrefilterChange: (value: string) => void;
  onMaxRunsPerHourChange: (value: string) => void;
}

export const CronEventLimitFields: React.FC<CronEventLimitFieldsProps> = ({
  prefilter, maxRunsPerHour, onPrefilterChange, onMaxRunsPerHourChange,
}) => {
  const { t } = useI18n();
  const copy = t.cronCenter.eventLimits;
  return (
    <div className="space-y-3" data-testid="cron-event-limit-fields">
      <FormField label={copy.prefilterLabel} hint={copy.prefilterHint}>
        <Input
          value={prefilter}
          maxLength={CRON_EVENT_TRIGGER.MAX_PREFILTER_CHARS}
          onChange={(event) => onPrefilterChange(event.target.value)}
          placeholder={copy.prefilterPlaceholder}
          data-testid="cron-event-prefilter-input"
        />
      </FormField>
      <FormField label={copy.maxRunsLabel} hint={copy.maxRunsHint}>
        <Input
          type="number"
          min={CRON_EVENT_TRIGGER.MIN_MAX_RUNS_PER_HOUR}
          max={CRON_EVENT_TRIGGER.MAX_MAX_RUNS_PER_HOUR}
          step={1}
          value={maxRunsPerHour}
          onChange={(event) => onMaxRunsPerHourChange(event.target.value)}
          placeholder={copy.maxRunsPlaceholder}
          data-testid="cron-event-max-runs-input"
        />
      </FormField>
    </div>
  );
};
