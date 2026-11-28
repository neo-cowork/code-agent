// ============================================================================
// RoleSkillsEditor - 专家详情「技能与工具」编辑器
// ============================================================================
// 普通模式按能力分组展示（与 RoleBasicSummary / RolePackShelf 共享 roleToolCapabilities
// 同一套映射），不暴露内部工具名；开发者模式额外展示原始工具逐项勾选和原始未识别清单。

import React, { useMemo, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { RolePanelDetail } from '@shared/contract/roleAssets';
import ipcService from '../../../services/ipcService';
import { useI18n } from '../../../hooks/useI18n';
import { interpolatePlural } from '../../../i18n/interpolate';
import { useAppStore } from '../../../stores/appStore';
import { getRoleToolCapabilityGroup } from '../../../utils/roleToolCapabilities';
import { Badge, Button } from '../../primitives';
import { SettingsSection } from '../settings/SettingsLayout';

type Equipment = NonNullable<RolePanelDetail['equipment']>;

const ABILITY_GROUP_ORDER: readonly string[] = [
  'readAndFindFiles',
  'writeAndEditFiles',
  'runCommands',
  'searchTheWeb',
  'openWebPages',
  'rememberAndRecall',
  'connector:mail',
  'connector:calendar',
  'connector:reminders',
  'connector:tmeet',
  'connector:feishu',
];

function normalizeUnmappedToolKey(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/[-_\s]/g, '');
}

async function updateRoleEquipment(
  roleId: string,
  equipment: Pick<Equipment, 'skills' | 'tools' | 'model' | 'maxIterations'> & {
    modelOverride?: Equipment['modelOverride'] | null;
  },
): Promise<void> {
  await ipcService.invokeDomain(IPC_DOMAINS.ROLES, 'updateEquipment', { roleId, equipment });
}

/** 技能页只管 技能/工具/迭代上限；模型档位与指定模型搬去模型页，保存时原样带回不丢。 */
export const RoleSkillsEditor: React.FC<{
  roleId: string;
  equipment: Equipment;
  onSaved: () => void;
}> = ({ roleId, equipment, onSaved }) => {
  const { t } = useI18n();
  const text = t.expert.roleDetail;
  const skillsText = t.expert.roleSkills;
  const capabilityLabels = t.receiptPresentation.roleCapabilityLabels;
  const humanToolLabels = t.receiptPresentation.humanToolLabels;
  const developerMode = useAppStore((state) => state.developerMode);

  const [draft, setDraft] = useState(() => ({
    skills: equipment.skills,
    tools: equipment.tools,
    maxIterations: equipment.maxIterations,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableToolSet = useMemo(
    () => new Set(equipment.availableTools),
    [equipment.availableTools],
  );

  const unknownTools = useMemo(
    () => [...new Set(draft.tools.filter((tool) => !availableToolSet.has(tool)))],
    [draft.tools, availableToolSet],
  );

  const abilityGroups = useMemo(() => {
    const grouped = new Map<string, {
      id: string;
      label: string;
      kind: 'capability' | 'connector';
      allMembers: string[];
    }>();

    for (const tool of equipment.availableTools) {
      const group = getRoleToolCapabilityGroup({
        toolName: tool,
        capabilityLabels,
        humanToolLabels,
      });
      if (!group) continue;
      const existing = grouped.get(group.id);
      if (existing) {
        if (!existing.allMembers.includes(tool)) existing.allMembers.push(tool);
      } else {
        grouped.set(group.id, { ...group, allMembers: [tool] });
      }
    }

    return [...grouped.values()]
      .map((group) => {
        const registrySpellings = group.kind === 'capability'
          ? group.allMembers.filter((name) => /^[A-Z]/.test(name))
          : group.allMembers;
        return {
          ...group,
          addMembers: registrySpellings.length > 0 ? registrySpellings : group.allMembers,
        };
      })
      .sort((a, b) => {
        const ai = ABILITY_GROUP_ORDER.indexOf(a.id);
        const bi = ABILITY_GROUP_ORDER.indexOf(b.id);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return 0;
      });
  }, [equipment.availableTools, capabilityLabels, humanToolLabels]);

  const checkedGroupIds = useMemo(() => {
    const ids = new Set<string>();
    for (const tool of draft.tools) {
      const group = getRoleToolCapabilityGroup({
        toolName: tool,
        capabilityLabels,
        humanToolLabels,
      });
      if (group) ids.add(group.id);
    }
    return ids;
  }, [draft.tools, capabilityLabels, humanToolLabels]);

  const otherAbilitiesCount = useMemo(() => {
    const seen = new Set<string>();
    for (const rawTool of draft.tools) {
      const tool = rawTool.trim();
      if (!tool || !availableToolSet.has(tool)) continue;
      const group = getRoleToolCapabilityGroup({
        toolName: tool,
        capabilityLabels,
        humanToolLabels,
      });
      if (!group) seen.add(normalizeUnmappedToolKey(tool));
    }
    return seen.size;
  }, [draft.tools, availableToolSet, capabilityLabels, humanToolLabels]);

  const otherAbilitiesText = otherAbilitiesCount > 0
    ? (otherAbilitiesCount === 1 ? capabilityLabels.otherAbility : capabilityLabels.otherAbilities)
      .replace('{count}', String(otherAbilitiesCount))
    : null;

  const toggle = (key: 'skills' | 'tools', value: string) => {
    setDraft((current) => ({
      ...current,
      [key]: current[key].includes(value)
        ? current[key].filter((item) => item !== value)
        : [...current[key], value],
    }));
  };

  const toggleAbilityGroup = (group: { id: string; addMembers: string[] }) => {
    setDraft((current) => {
      const isChecked = current.tools.some(
        (tool) => getRoleToolCapabilityGroup({
          toolName: tool,
          capabilityLabels,
          humanToolLabels,
        })?.id === group.id,
      );
      if (isChecked) {
        return {
          ...current,
          tools: current.tools.filter(
            (tool) => getRoleToolCapabilityGroup({
              toolName: tool,
              capabilityLabels,
              humanToolLabels,
            })?.id !== group.id,
          ),
        };
      }
      const nextTools = [...current.tools];
      for (const member of group.addMembers) {
        if (!nextTools.includes(member)) nextTools.push(member);
      }
      return { ...current, tools: nextTools };
    });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateRoleEquipment(roleId, {
        ...draft,
        model: equipment.model,
        modelOverride: equipment.modelOverride ?? null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={skillsText.title} description={skillsText.description}>
      <div data-testid="role-equipment-editor" className="space-y-4">
        <label className="block space-y-1 text-xs text-zinc-400">
          <span>{text.maxIterations}</span>
          <input
            data-testid="role-equipment-max-iterations"
            type="number"
            min={1}
            max={200}
            value={draft.maxIterations}
            onChange={(event) => setDraft({
              ...draft,
              maxIterations: Math.max(1, Math.min(200, Number(event.target.value) || 1)),
            })}
            className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-2 py-1.5 text-sm text-zinc-200"
          />
        </label>

        <fieldset>
          <legend className="mb-1 text-xs text-zinc-400">{text.skills}</legend>
          <div className="grid max-h-40 grid-cols-2 gap-1 overflow-auto rounded border border-zinc-800 p-2">
            {equipment.availableSkills.map((skill) => (
              <label key={skill} className="flex items-center gap-1.5 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={draft.skills.includes(skill)}
                  onChange={() => toggle('skills', skill)}
                />
                {skill}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset data-testid="role-ability-groups">
          <legend className="mb-1 text-xs text-zinc-400">{skillsText.abilitiesTitle}</legend>
          <div className="grid max-h-48 grid-cols-2 gap-1.5 overflow-auto rounded border border-zinc-800 p-2">
            {abilityGroups.map((group) => (
              <label
                key={group.id}
                data-testid={`role-ability-group-${group.id}`}
                className="flex items-center gap-1.5 text-xs text-zinc-300"
              >
                <input
                  type="checkbox"
                  checked={checkedGroupIds.has(group.id)}
                  onChange={() => toggleAbilityGroup(group)}
                />
                {group.label}
              </label>
            ))}
          </div>
          {otherAbilitiesText ? (
            <p data-testid="role-other-abilities" className="mt-1.5 text-xs text-zinc-400">
              {otherAbilitiesText}
            </p>
          ) : null}
        </fieldset>

        {developerMode ? (
          <fieldset data-testid="role-raw-tools">
            <legend className="mb-1 text-xs text-zinc-400">{text.tools}</legend>
            <div className="grid max-h-48 grid-cols-2 gap-1 overflow-auto rounded border border-zinc-800 p-2">
              {equipment.availableTools.map((tool) => (
                <label key={tool} className="flex items-center gap-1.5 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={draft.tools.includes(tool)}
                    onChange={() => toggle('tools', tool)}
                  />
                  {tool}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        {unknownTools.length > 0 ? (
          developerMode ? (
            <ul data-testid="role-unknown-tools" className="space-y-1 text-xs text-badge-warning">
              {unknownTools.map((tool) => (
                <li key={tool} className="flex items-center gap-2">
                  <span>{tool}</span>
                  <Badge>{skillsText.toolNeedsCheck}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <div data-testid="role-unknown-tools" className="flex items-center gap-2 text-xs text-badge-warning">
              <span>{interpolatePlural(skillsText.unknownAbilitiesCount, unknownTools.length)}</span>
              <Badge>{skillsText.toolNeedsCheck}</Badge>
            </div>
          )
        ) : null}

        <Button
          variant="primary"
          size="sm"
          data-testid="role-equipment-save"
          type="button"
          loading={busy}
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? skillsText.saving : skillsText.save}
        </Button>

        {error ? <div className="text-xs text-badge-danger">{error}</div> : null}
      </div>
    </SettingsSection>
  );
};
