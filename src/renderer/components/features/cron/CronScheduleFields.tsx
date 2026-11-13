// ============================================================================
// CronScheduleFields —— 手动编辑器「调度方式」里的三个时间型调度字段组
//（at 执行时间 / every 间隔循环 / cron 表达式）。
// 自 CronJobEditor.tsx 逐字搬出（N-TRIGGER-MAIL-CREATE-ENTRY-K1：编辑器逼近
// max-lines 棘轮，事件源新增第 5 种调度类型 'event-mail' 前先把这块收拢）。
// 渲染条件（scheduleType 分支选择）留在编辑器，本组件只管字段本体。
// ============================================================================

import React from 'react';
import { isHourAlignedCronExpression, suggestCronStaggerMinute } from '@shared/cronStagger';
import { FormField } from '../../composites/FormField';
import { Input } from '../../primitives/Input';
import { DateTimeInput24 } from '../../primitives/DateTimeInput24';
import { Select } from '../../primitives/Select';
import { useI18n } from '../../../hooks/useI18n';
import type { CronJobDraft } from './types';
import { localCronTimezone } from './localTimezone';

interface CronScheduleFieldsProps {
  draft: Pick<
    CronJobDraft,
    'scheduleType' | 'atDatetime' | 'everyInterval' | 'everyUnit' | 'everyStartAt' | 'everyEndAt' | 'cronExpression' | 'cronTimezone' | 'runsOn'
  >;
  setField: <K extends keyof CronJobDraft>(key: K, value: CronJobDraft[K]) => void;
  errors: Partial<Record<'atDatetime' | 'everyInterval' | 'cronExpression', string>>;
}

export const CronScheduleFields: React.FC<CronScheduleFieldsProps> = ({ draft, setField, errors }) => {
  const { t } = useI18n();
  const cc = t.cronCenter;

  return (
    <>
      {draft.scheduleType === 'at' && (
        <FormField label={cc.editorChrome.executionTimeLabel} required error={errors.atDatetime}>
          <DateTimeInput24
            testId="cron-editor-at"
            value={draft.atDatetime}
            onChange={(value) => setField('atDatetime', value)}
            dateLabel={cc.simpleDateLabel}
            hourLabel={cc.simpleHourLabel}
            minuteLabel={cc.simpleMinuteLabel}
          />
        </FormField>
      )}

      {draft.scheduleType === 'every' && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={cc.editorChrome.intervalValueLabel} required error={errors.everyInterval}>
              <Input
                type="number"
                min={draft.runsOn === 'cloud'
                  ? (draft.everyUnit === 'minutes' ? 60 : 1)
                  : (draft.everyUnit === 'minutes' ? 5 : 1)}
                value={draft.everyInterval}
                onChange={(e) => setField('everyInterval', e.target.value)}
              />
            </FormField>
            <FormField label={cc.editorChrome.intervalUnitLabel}>
              <Select
                value={draft.everyUnit}
                onChange={(e) => setField('everyUnit', e.target.value as CronJobDraft['everyUnit'])}
                options={[
                  { value: 'minutes', label: cc.editorChrome.intervalUnitMinutes },
                  { value: 'hours', label: cc.editorChrome.intervalUnitHours },
                  { value: 'days', label: cc.editorChrome.intervalUnitDays },
                ]}
              />
            </FormField>
          </div>
          <p className="text-xs text-zinc-500" data-testid="cron-min-interval-hint">
            {draft.runsOn === 'cloud' ? cc.cloudIntervalHint : cc.localIntervalHint}
          </p>
          {(draft.everyUnit === 'hours' || draft.everyUnit === 'days') && (
            <p className="text-xs text-zinc-500" data-testid="cron-auto-stagger-hint">
              {draft.everyUnit === 'hours' ? cc.editorChrome.hourlyStaggerHint : cc.editorChrome.dailyStaggerHint}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={cc.editorChrome.startTimeLabel}>
              <Input
                type="text"
                value={draft.everyStartAt}
                onChange={(e) => setField('everyStartAt', e.target.value)}
                placeholder={cc.editorChrome.optionalPlaceholder}
                className="font-mono"
              />
            </FormField>
            <FormField label={cc.editorChrome.endTimeLabel}>
              <Input
                type="text"
                value={draft.everyEndAt}
                onChange={(e) => setField('everyEndAt', e.target.value)}
                placeholder={cc.editorChrome.optionalPlaceholder}
                className="font-mono"
              />
            </FormField>
          </div>
        </>
      )}

      {draft.scheduleType === 'cron' && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={cc.editorChrome.cronExpressionLabel} required error={errors.cronExpression}>
              <Input
                value={draft.cronExpression}
                onChange={(e) => setField('cronExpression', e.target.value)}
                className="font-mono"
              />
            </FormField>
            <FormField label={cc.editorChrome.timezoneLabel}>
              <Input
                value={draft.cronTimezone}
                onChange={(e) => setField('cronTimezone', e.target.value)}
                placeholder={localCronTimezone()}
              />
            </FormField>
          </div>
          {isHourAlignedCronExpression(draft.cronExpression) && (
            <p className="text-xs text-badge-warning" data-testid="cron-stagger-hint">
              {cc.editorChrome.cronStaggerHint.replace('{minute}', String(suggestCronStaggerMinute(draft.cronExpression)))}
            </p>
          )}
        </div>
      )}
    </>
  );
};
