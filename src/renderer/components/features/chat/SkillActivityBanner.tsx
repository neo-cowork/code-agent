import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import type { TurnSkillActivity } from '@shared/contract/turnTimeline';
import { resolveSkillName } from '@shared/resolveSkillName';
import { useI18n } from '../../../hooks/useI18n';
import { Button } from '../../primitives/Button';

/** The turn header receives stored structural activity, never its host-built summary copy. */
export const SkillActivityBanner: React.FC<{ activity: TurnSkillActivity }> = ({ activity }) => {
  const { t, language } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const labels = activity.items.map((item) => {
    const name = resolveSkillName(item.skillId, language, '');
    return name ? `${name} · ${t.skillTimeline[item.action]}` : t.toolStepHumanize.skillFallback;
  });
  const summary = [...new Set(labels)].join(t.toolStepHumanize.listSeparator);
  return (
    <div className="py-0.5 text-sm text-zinc-500" data-testid="skill-activity-banner">
      <Button
        variant="ghost" size="sm" type="button"
        className="flex min-w-0 items-center gap-2 rounded-md px-0 py-0.5 text-left text-zinc-500 transition-colors hover:text-zinc-300"
        onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} title={summary}
      >
        <Sparkles className="h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate font-medium">{summary}</span>
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-600" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />}
      </Button>
      {expanded && (
        <div className="ml-7 mt-1 space-y-1 text-[13px] leading-5 text-zinc-500">
          {activity.items.map((item, index) => (
            <div key={`${item.skillId}-${item.action}-${index}`} className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-zinc-400">{resolveSkillName(item.skillId, language, t.turnSections.skills)}</span>
              <span className="shrink-0">{t.skillTimeline[item.action]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
