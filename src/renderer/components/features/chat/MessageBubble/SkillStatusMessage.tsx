import { resolveSkillName } from '@shared/resolveSkillName';
import type { Message } from '@shared/contract';
import { useI18n } from '../../../../hooks/useI18n';
import type { Language, Translations } from '../../../../i18n';
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

export function formatSkillStatusText(
  content: string,
  t: Pick<Translations, 'toolStepHumanize'>,
  language: Language,
): string | null {
  const { message, name } = parseSkillContent(content);
  if (!message) {
    return null;
  }
  const skillName = resolveSkillName(name ?? undefined, language, '');
  return skillName ? t.toolStepHumanize.skill.replace('{skill}', skillName) : t.toolStepHumanize.skillFallback;
}

/**
 * SkillStatusMessage Component
 *
 * Displays a compact status indicator when a Skill is being loaded or activated.
 * Used for messages with source='skill' and containing <command-message> tags.
 */
export const SkillStatusMessage: React.FC<SkillStatusMessageProps> = ({ content }) => {
  const { t, language } = useI18n();
  const tooltip = formatSkillStatusText(content, t, language);

  // If no valid message format, don't render anything
  if (!tooltip) {
    return null;
  }

  return (
    <div className="skill-status px-1 py-1 text-xs text-zinc-500 flex items-center gap-1.5" title={tooltip}>
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

/**
 * Check if a message row represents a host skill activation status envelope.
 */
export function isSkillStatusMessage(
  message: Pick<Message, 'role' | 'content'> & Partial<Pick<Message, 'source' | 'metadata'>>,
): boolean {
  if (message.role !== 'user' || typeof message.content !== 'string' || !isSkillStatusContent(message.content)) {
    return false;
  }
  return (
    message.source === 'skill' ||
    message.metadata?.skill?.phase === 'status' ||
    message.content.startsWith('<command-message>')
  );
}
