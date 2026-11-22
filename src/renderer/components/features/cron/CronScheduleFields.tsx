// ============================================================================
// CronScheduleFields —— 手动编辑器「调度方式」里的三个时间型调度字段组
//（at 执行时间 / every 间隔循环 / cron 表达式）。
// 自 CronJobEditor.tsx 逐字搬出（N-TRIGGER-MAIL-CREATE-ENTRY-K1：编辑器逼近
// max-lines 棘轮，事件源新增第 5 种调度类型 'event-mail' 前先把这块收拢）。
// 渲染条件（scheduleType 分支选择）留在编辑器，本组件只管字段本体。
// ============================================================================

import React, { useState } from 'react';
import { isHourAlignedCronExpression, suggestCronStaggerMinute } from '@shared/cronStagger';
import { FormField } from '../../composites/FormField';
import { Input } from '../../primitives/Input';
import { DateTimeInput24 } from '../../primitives/DateTimeInput24';
import { Select } from '../../primitives/Select';
import { Button } from '../../primitives/Button';
import { TimeInput24 } from '../../primitives';
import { formatCronExpressionLabel } from '@shared/cronHumanize';
import { compileSimpleSchedule, decompileSimpleSchedule, type SimpleFrequency } from './CronSimpleCreate';
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
        <CronBranch draft={draft} setField={setField} errors={errors} />
      )}
    </>
  );
};

const CronBranch: React.FC<CronScheduleFieldsProps> = ({ draft, setField, errors }) => {
  const { t, language } = useI18n();
  const cc = t.cronCenter;
  const simple = decompileSimpleSchedule(draft.cronExpression);
  const [customPick, setCustomPick] = useState<boolean | null>(null);
  const custom = customPick ?? simple === null;
  const showSimple = !custom && simple !== null;

  const update = (next: { freq: SimpleFrequency; time: string; weekday: string }) => {
    const compiled = compileSimpleSchedule({ ...next, intervalHours: '1', onceAt: '' });
    setField('cronExpression', compiled.cronExpression ?? draft.cronExpression);
  };

  const timezoneField = (
    <FormField label={cc.editorChrome.timezoneLabel}>
      <Input
        value={draft.cronTimezone}
        onChange={(e) => setField('cronTimezone', e.target.value)}
        placeholder={localCronTimezone()}
      />
    </FormField>
  );

  return (
    <div className="space-y-3">
      {showSimple ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label={cc.simpleFreqLabel}>
            <Select
              value={simple.freq}
              onChange={(e) => update({ ...simple, freq: e.target.value as SimpleFrequency })}
              options={[
                { value: 'daily', label: cc.freqDaily },
                { value: 'weekdays', label: cc.freqWeekdays },
                { value: 'weekly', label: cc.freqWeekly },
              ]}
            />
          </FormField>
          <FormField label={cc.simpleTimeLabel}>
            <TimeInput24
              testId="cron-editor-time"
              value={simple.time}
              onChange={(time) => update({ ...simple, time })}
              hourLabel={cc.simpleHourLabel}
              minuteLabel={cc.simpleMinuteLabel}
            />
          </FormField>
          {simple.freq === 'weekly' && (
            <FormField label={cc.simpleWeekdayLabel}>
              <Select
                value={simple.weekday}
                onChange={(e) => update({ ...simple, weekday: e.target.value })}
                options={cc.weekdays.map((label: string, i: number) => ({ value: String(i), label }))}
              />
            </FormField>
          )}
          {timezoneField}
          <div className="sm:col-span-2">
            <Button variant="ghost" size="sm" data-testid="cron-use-custom" onClick={() => setCustomPick(true)}>
              {cc.editorChrome.cronUseCustomLink}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={cc.editorChrome.cronExpressionLabel} required error={errors.cronExpression}>
              <Input
                value={draft.cronExpression}
                onChange={(e) => {
                  setCustomPick(true);
                  setField('cronExpression', e.target.value);
                }}
                className="font-mono"
              />
            </FormField>
            {timezoneField}
          </div>
          <p className="text-xs text-zinc-500" data-testid="cron-custom-hint">{cc.editorChrome.cronCustomHint}</p>
          {draft.cronExpression.trim() !== '' && (
            <p className="text-xs text-zinc-400" data-testid="cron-custom-preview">
              {cc.editorChrome.cronPreviewLabel}：{formatCronExpressionLabel(draft.cronExpression, draft.cronTimezone || undefined, language)}
            </p>
          )}
          {simple !== null && (
            <Button variant="ghost" size="sm" data-testid="cron-back-simple" onClick={() => setCustomPick(false)}>
              {cc.editorChrome.cronBackToSimpleLink}
            </Button>
          )}
        </>
      )}
      {isHourAlignedCronExpression(draft.cronExpression) && (
        <p className="text-xs text-badge-warning" data-testid="cron-stagger-hint">
          {cc.editorChrome.cronStaggerHint.replace('{minute}', String(suggestCronStaggerMinute(draft.cronExpression)))}
        </p>
      )}
    </div>
  );
};
