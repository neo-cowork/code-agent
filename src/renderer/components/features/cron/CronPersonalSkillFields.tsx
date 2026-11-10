import React, { useEffect, useId } from 'react';
import { CRON_PERSONAL_SKILLS } from '@shared/constants/cronPersonalSkills';
import { normalizePersonalSkillIds } from '@shared/cronPersonalSkills';
import { useI18n } from '../../../hooks/useI18n';
import { cronPersonalSkills } from '../../../i18n/cronPersonalSkills';
import { useSkillStore } from '../../../stores/skillStore';
import type { CronJobDraft } from './types';

interface Props {
  draft: CronJobDraft;
  setField: <K extends keyof CronJobDraft>(key: K, value: CronJobDraft[K]) => void;
}

export function CronPersonalSkillFields({ draft, setField }: Props) {
  const { language } = useI18n();
  const copy = cronPersonalSkills[language];
  const hintId = useId();
  const availableSkills = useSkillStore((state) => state.availableSkills);
  const fetchAvailableSkills = useSkillStore((state) => state.fetchAvailableSkills);
  useEffect(() => { void fetchAvailableSkills(); }, [fetchAvailableSkills]);
  const personalSkills = availableSkills.filter((skill) => skill.source === 'user');
  const selected = normalizePersonalSkillIds(draft.agentAllowedPersonalSkillIds) ?? [];

  return (
    <fieldset className="min-w-0 space-y-2" data-testid="cron-personal-skills" aria-describedby={hintId}>
      <legend className="text-sm text-zinc-400">{copy.label}</legend>
      <p id={hintId} className="text-xs text-zinc-500">{copy.hint}</p>
      {personalSkills.length === 0 ? <p className="text-sm text-zinc-400">{copy.empty}</p> : (
        <div className="space-y-2">
          {personalSkills.map((skill) => (
            <label key={skill.name} className="flex min-w-0 items-start gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                className="mt-1 shrink-0 accent-primary-500"
                checked={selected.includes(skill.name)}
                disabled={!selected.includes(skill.name) && selected.length >= CRON_PERSONAL_SKILLS.MAX_IDS}
                onChange={(event) => setField('agentAllowedPersonalSkillIds', event.target.checked
                  ? [...selected, skill.name] : selected.filter((name) => name !== skill.name))}
              />
              <span className="min-w-0 flex-1">
                <span className="block">{skill.name}</span>
                <span className="block truncate text-xs text-zinc-500" title={skill.description}>{skill.description}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
