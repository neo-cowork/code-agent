import { CRON_PERSONAL_SKILLS } from './constants/cronPersonalSkills';

/** Store skill names only; never accept paths, commands, or truncated names. */
export function normalizePersonalSkillIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name || name.length > CRON_PERSONAL_SKILLS.MAX_NAME_CHARS
      || !/^[\p{L}\p{N}_][\p{L}\p{N}_.:-]*$/u.test(name) || name === '.' || name === '..') continue;
    names.add(name);
    if (names.size === CRON_PERSONAL_SKILLS.MAX_IDS) break;
  }
  return names.size ? [...names] : undefined;
}
