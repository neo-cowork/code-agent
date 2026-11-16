import { resolveSkillName } from '@shared/resolveSkillName';
import { useI18n } from '../../../../hooks/useI18n';
// ============================================================================
// SkillStatusMessage - Display Skill activation status
// ============================================================================
// Renders special status messages when a Skill is being loaded/activated.
// Shows a loading spinner with the skill name in a compact, styled format.
// ============================================================================

import React from 'react';
import { Lightbulb } from 'lucide-react';

export interface SkillStatusMessageProps {
  content: string;
}

/**
 * Parse skill status message content
 * Expected format: <command-message>Loading skill: xxx</command-message><command-name>xxx</command-name>
 */
function parseSkillContent(content: string): { message: string | null; name: string | null } {
  const messageMatch = content.match(/<command-message>(.+?)<\/command-message>/);
  const nameMatch = content.match(/<command-name>(.+?)<\/command-name>/);

  return {
    message: messageMatch ? messageMatch[1] : null,
    name: nameMatch ? nameMatch[1] : null,
  };
}

/**
 * SkillStatusMessage Component
 *
 * Displays a compact status indicator when a Skill is being loaded or activated.
 * Used for messages with source='skill' and containing <command-message> tags.
 */
export const SkillStatusMessage: React.FC<SkillStatusMessageProps> = ({ content }) => {
  const { t, language } = useI18n();
  const { message, name } = parseSkillContent(content);

  // If no valid message format, don't render anything
  if (!message) {
    return null;
  }

  // 灰色脚注样式，对照 Codex 的 "Using xxx skill" 一行提示
  // 鼠标悬停时通过 title 暴露原始 message（含 skill 描述）
  const skillName = resolveSkillName(name ?? undefined, language, '');
  const tooltip = skillName ? t.toolStepHumanize.skill.replace('{skill}', skillName) : t.toolStepHumanize.skillFallback;

  return (
    <div className="skill-status px-1 py-1 text-xs text-zinc-500 flex items-center gap-1.5" title={tooltip ?? undefined}>
      <Lightbulb className="w-3 h-3 text-zinc-500 flex-shrink-0" />
      <span className="truncate">
        {tooltip}
      </span>
    </div>
  );
};

/**
 * Check if a message content is a skill status message
 */
export function isSkillStatusContent(content: string): boolean {
  return content.includes('<command-message>') && content.includes('<command-name>');
}
