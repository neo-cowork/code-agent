import type { RoleLabels } from '../stores/roleLabelsStore';

const EDIT_ROLE_SINGLE_LINE_PATTERN = /^\/edit-role\s+(\S.*)$/;

/**
 * Render-time projection for deterministic `/edit-role <roleId>` seed messages:
 * maps a single-line `/edit-role <roleId>` user message to plain language
 * (`修改专家：<roleId>` / `Edit expert: <roleId>`), leaving stored/sent/rewound
 * text and any non-matching or multi-line input unchanged.
 */
export function formatEditRoleUserPrompt(text: string, template: string, labels: RoleLabels = {}): string {
  if (!text || text.includes('\n') || text.includes('\r')) {
    return text;
  }
  const match = EDIT_ROLE_SINGLE_LINE_PATTERN.exec(text);
  if (!match) {
    return text;
  }
  const role = match[1].trimEnd();
  return template.replace('{role}', () => Object.hasOwn(labels, role) ? labels[role] || role : role);
}
