import React, { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { CRON_AGENT_TYPES, CRON_URGENCY_CRITERIA } from '@shared/constants';
import { FormField } from '../../composites/FormField';
import { Input } from '../../primitives/Input';
import { Select } from '../../primitives/Select';
import { Textarea } from '../../primitives/Textarea';
import { useI18n } from '../../../hooks/useI18n';
import type { CronJobDraft } from './types';
import { CronPersonalSkillFields } from './CronPersonalSkillFields';

interface CronAgentActionFieldsProps {
  draft: CronJobDraft;
  setField: <K extends keyof CronJobDraft>(key: K, value: CronJobDraft[K]) => void;
  errors: Partial<Record<keyof CronJobDraft, string>>;
}

function hasExtraParameters(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
      || Object.keys(parsed as Record<string, unknown>).length > 0;
  } catch {
    return true;
  }
}

export const CronAgentActionFields: React.FC<CronAgentActionFieldsProps> = ({ draft, setField, errors }) => {
  const { t } = useI18n();
  const copy = t.cronCenter.manualEditor;
  const [contextExpanded, setContextExpanded] = useState(() => hasExtraParameters(draft.agentContextText));
  const agentTypeOptions = useMemo(() => {
    const options = CRON_AGENT_TYPES.map((value) => ({
      value,
      label: `${copy.agentTypes[value].name} — ${copy.agentTypes[value].description}`,
    }));
    const storedValue = draft.agentType.trim();
    if (storedValue && !(CRON_AGENT_TYPES as readonly string[]).includes(storedValue)) {
      options.push({
        value: storedValue as typeof CRON_AGENT_TYPES[number],
        label: `${storedValue} — ${copy.unknownAgentTypeDescription}`,
      });
    }
    return options;
  }, [copy, draft.agentType]);

  return (
    <>
      <FormField label={copy.agentTypeLabel} required error={errors.agentType}>
        <Select
          data-testid="cron-agent-type-select"
          value={draft.agentType}
          options={agentTypeOptions}
          onChange={(event) => setField('agentType', event.target.value)}
        />
      </FormField>
      <FormField label={copy.taskInstructionsLabel} required error={errors.agentPrompt}>
        <Textarea
          data-testid="cron-agent-task-instructions"
          value={draft.agentPrompt}
          onChange={(event) => setField('agentPrompt', event.target.value)}
          minRows={5}
        />
      </FormField>
      <FormField label={t.cronCenter.urgencyCriteriaLabel} hint={t.cronCenter.urgencyCriteriaHint}>
        <Input
          value={draft.agentUrgencyCriteria ?? ''}
          onChange={(event) => setField('agentUrgencyCriteria', event.target.value)}
          maxLength={CRON_URGENCY_CRITERIA.MAX_CHARS}
          placeholder={t.cronCenter.urgencyCriteriaPlaceholder}
          data-testid="cron-agent-urgency-criteria"
        />
      </FormField>
      <CronPersonalSkillFields draft={draft} setField={setField} />
      <details
        className="group rounded-lg border border-zinc-800 bg-zinc-950/30 px-3 py-2"
        data-testid="cron-agent-context-disclosure"
        open={contextExpanded}
        onToggle={(event) => setContextExpanded(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm text-zinc-400 transition-colors hover:text-zinc-200 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
          {copy.extraParametersDisclosure}
        </summary>
        <div className="mt-3 space-y-2 border-t border-zinc-800 pt-3">
          <p className="text-xs text-zinc-500">{copy.extraParametersHint}</p>
          <code className="block rounded-md bg-zinc-900 px-2.5 py-2 text-xs text-zinc-400">
            {copy.extraParametersExample}
          </code>
          <FormField label={copy.extraParametersInputLabel} error={errors.agentContextText}>
            <Textarea
              data-testid="cron-agent-context-input"
              value={draft.agentContextText}
              onChange={(event) => setField('agentContextText', event.target.value)}
              minRows={4}
              className="font-mono"
            />
          </FormField>
        </div>
      </details>
    </>
  );
};
