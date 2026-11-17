import React from 'react';
import { localizeBuiltinRole } from '@shared/localizeBuiltinRole';
import type { RolePanelDetail } from '@shared/contract/roleAssets';
import { useI18n } from '../../../hooks/useI18n';
import { humanizeInternalText } from '@shared/humanizeInternalText';
import { getRoleToolCapabilities } from '../../../utils/roleToolCapabilities';

// agentMdLoader 在定义没写 description 时塞的英文占位，不是用户写的简介
const PLACEHOLDER_INTRO = /^Custom agent:\s/;

export const RoleBasicSummary: React.FC<{ detail: RolePanelDetail }> = ({ detail }) => {
  const { t, language } = useI18n();
  const shown = localizeBuiltinRole(detail.roleId, { name: detail.visual.displayName ?? '', profession: detail.visual.profession }, language);
  const text = t.expert.basicSummary;
  const intro = detail.description?.trim();
  const showIntro = Boolean(intro) && !PLACEHOLDER_INTRO.test(intro as string);
  const abilities = getRoleToolCapabilities({
    toolNames: detail.equipment?.tools ?? [],
    capabilityLabels: t.receiptPresentation.roleCapabilityLabels,
    humanToolLabels: t.receiptPresentation.humanToolLabels,
  });
  return (
    <div data-testid="role-basic-summary" className="space-y-2 rounded-lg border border-zinc-700 bg-zinc-800/40 p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span data-testid="role-basic-summary-name" className="font-medium text-zinc-100">{shown.name || humanizeInternalText(detail.roleId, language).text}</span>
        {shown.profession ? <span className="text-xs text-zinc-400">{shown.profession}</span> : null}
      </div>
      {showIntro ? <p data-testid="role-basic-summary-intro" className="text-zinc-300">{intro}</p> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-zinc-400">{text.abilities}</span>
        {abilities.length > 0
          ? abilities.map((label) => <span key={label} data-testid="role-basic-summary-ability" className="whitespace-nowrap rounded bg-zinc-700/60 px-2 py-0.5 text-xs text-zinc-200">{label}</span>)
          : <span data-testid="role-basic-summary-no-abilities" className="text-xs text-zinc-500">{text.noAbilities}</span>}
      </div>
    </div>
  );
};
