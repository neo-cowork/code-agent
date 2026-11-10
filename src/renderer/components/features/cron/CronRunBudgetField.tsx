import React from 'react';
import { FormField } from '../../composites/FormField';
import { Input } from '../../primitives/Input';
import { useI18n } from '../../../hooks/useI18n';
import { FlatFeeBudgetNote } from './FlatFeeBudgetNote';

interface CronRunBudgetFieldProps {
  value: string;
  onChange: (value: string) => void;
}

export const CronRunBudgetField: React.FC<CronRunBudgetFieldProps> = ({ value, onChange }) => {
  const { t } = useI18n();
  const cc = t.cronCenter;

  return (
    <div className="space-y-1.5">
    <FormField label={cc.runBudgetLabel} hint={cc.runBudgetHint}>
      <Input
        type="number"
        min={0}
        step="0.01"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={cc.runBudgetPlaceholder}
        data-testid="cron-budget-limit-input"
      />
    </FormField>
    <FlatFeeBudgetNote variant="cron" />
    </div>
  );
};
