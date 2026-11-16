import { ALMA_BUNDLED_SKILL_MAPPINGS, RECOMMENDED_SKILLS, SKILL_ROLE_BUNDLES } from './constants/skillCatalog';
import type { InternalTextLanguage } from './humanizeInternalText';

// Resolve catalog identities at presentation time; never rename stored/user-installed skills.
const catalog = new Map<string, string>();
for (const skill of [
  ...RECOMMENDED_SKILLS,
  ...ALMA_BUNDLED_SKILL_MAPPINGS,
  ...SKILL_ROLE_BUNDLES.flatMap((bundle) => bundle.skills),
]) {
  if (!catalog.has(skill.name)) catalog.set(skill.name, skill.displayName);
}

/** The caller supplies its existing no-name wording when the catalog has no English name. */
export function resolveSkillName(name: string | undefined, language: InternalTextLanguage, fallback: string): string {
  if (!name) return fallback;
  const displayName = catalog.get(name);
  if (displayName === undefined) return name;
  return language === 'zh' || !/[\u3400-\u9fff\uf900-\ufaff]/.test(displayName) ? displayName : fallback;
}
