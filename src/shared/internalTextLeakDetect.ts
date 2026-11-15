// 内部文案外露检测（N-UX-INTERNAL-TEXT-LEAK-SYSTEMIC-CORE）：humanizeInternalText 与 CI 门共用的检测器。
import { RECOMMENDED_SKILLS, ALMA_BUNDLED_SKILL_MAPPINGS, SKILL_ROLE_BUNDLES } from './constants/skillCatalog';
import leakPatterns from './internalTextLeakPatterns.json';

export type InternalTextFormat =
  | 'uuid'
  | 'session_id'
  | 'call_id'
  | 'ou_id'
  | 'internal_tool_name'
  | 'english_state_word'
  | 'sandbox_exec'
  | 'temp_path'
  | 'raw_json'
  | 'cjk_in_en_ui'
  | 'catalog_slug';

// Only catalog ids are internal: user-installed skill names remain user data.
const catalogNames = [...new Set([
  ...RECOMMENDED_SKILLS.map((skill) => skill.name),
  ...ALMA_BUNDLED_SKILL_MAPPINGS.map((skill) => skill.name),
  ...SKILL_ROLE_BUNDLES.flatMap((bundle) => bundle.skills.map((skill) => skill.name)),
])].filter((name) => name.includes('-')).sort((a, b) => b.length - a.length);
export const CATALOG_SLUG_GLOBAL_RE = new RegExp(
  `(?<![A-Za-z0-9_/-])(?:${catalogNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z0-9_/-])`, 'g',
);
const CJK_GLOBAL_RE = /[\u3400-\u9fff\uf900-\ufaff]+/g;

export const UUID_EXACT_RE = new RegExp(
  `^(?:${leakPatterns.uuid.replace(/^\\b|\\b$/g, '')})$`,
  'i',
);
export const UUID_GLOBAL_RE = new RegExp(leakPatterns.uuid, 'gi');

export const SESSION_ID_EXACT_RE = new RegExp(`^(?:${leakPatterns.sessionId.replace(/^\\b|\\b$/g, '')})$`);
export const SESSION_ID_GLOBAL_RE = new RegExp(leakPatterns.sessionId, 'g');

export const CALL_ID_EXACT_RE = new RegExp(`^(?:${leakPatterns.callId.replace(/^\\b|\\b$/g, '')})$`);
export const CALL_ID_GLOBAL_RE = new RegExp(leakPatterns.callId, 'g');

export const OU_ID_EXACT_RE = new RegExp(`^(?:${leakPatterns.ouId.replace(/^\\b|\\b$/g, '')})$`);
export const OU_ID_GLOBAL_RE = new RegExp(leakPatterns.ouId, 'g');

const INTERNAL_TOOL_NAMES_SORTED = [...leakPatterns.internalToolNames].sort(
  (a, b) => b.length - a.length,
);

export const INTERNAL_TOOL_GLOBAL_RE = new RegExp(
  `${leakPatterns.internalToolPrefix}|(?<![A-Za-z0-9_/-])(?:${INTERNAL_TOOL_NAMES_SORTED.join('|')})(?![A-Za-z0-9_/-])`,
  'g',
);

export const ENGLISH_STATE_REGEXES: RegExp[] = leakPatterns.englishState.map(
  (pattern, index) => new RegExp(pattern, index === 0 ? 'g' : 'gi'),
);

export const SANDBOX_EXEC_COMMAND_RE = new RegExp(`${leakPatterns.sandboxExec}\\s+-f\\s+\\S+`, 'g');
export const SANDBOX_EXEC_TOKEN_RE = new RegExp(leakPatterns.sandboxExec, 'g');

export const TEMP_PATH_GLOBAL_RE = new RegExp(leakPatterns.tempPath, 'g');

export const INLINE_RAW_JSON_RE = new RegExp(`\\{(?:\\s*${leakPatterns.rawJsonKeyValue}\\s*,?){1,}\\}`, 'g');

/**
 * Inspect a user-visible string and return all internal-format leaks found.
 * Used both by the renderer humanizer and by the CI internal-text-leak gate.
 */
export function detectInternalTextLeaks(input: string, language?: 'zh' | 'en'): Array<{ format: InternalTextFormat; sample: string }> {
  if (!input?.trim()) return [];

  const matches: Array<{ format: InternalTextFormat; sample: string }> = [];
  const pushUnique = (format: InternalTextFormat, sample: string) => {
    if (!matches.some((m) => m.format === format && m.sample === sample)) {
      matches.push({ format, sample });
    }
  };
  const collectRegexMatches = (regex: RegExp, format: InternalTextFormat) => {
    regex.lastIndex = 0;
    for (const match of input.matchAll(regex)) {
      if (match[0]) pushUnique(format, match[0]);
    }
    regex.lastIndex = 0;
  };

  const trimmed = input.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        pushUnique('raw_json', trimmed.slice(0, 80));
      }
    } catch {
      // If it still looks like a raw JSON object literal with key-value pairs
      collectRegexMatches(INLINE_RAW_JSON_RE, 'raw_json');
    }
  } else {
    collectRegexMatches(INLINE_RAW_JSON_RE, 'raw_json');
  }

  if (language === 'en') collectRegexMatches(CJK_GLOBAL_RE, 'cjk_in_en_ui');
  if (language === 'zh') collectRegexMatches(/\bDone\b/g, 'english_state_word');
  collectRegexMatches(CATALOG_SLUG_GLOBAL_RE, 'catalog_slug');
  collectRegexMatches(UUID_GLOBAL_RE, 'uuid');
  collectRegexMatches(SESSION_ID_GLOBAL_RE, 'session_id');
  collectRegexMatches(CALL_ID_GLOBAL_RE, 'call_id');
  collectRegexMatches(OU_ID_GLOBAL_RE, 'ou_id');
  collectRegexMatches(INTERNAL_TOOL_GLOBAL_RE, 'internal_tool_name');

  for (const regex of ENGLISH_STATE_REGEXES) {
    collectRegexMatches(regex, 'english_state_word');
  }

  collectRegexMatches(SANDBOX_EXEC_COMMAND_RE, 'sandbox_exec');
  collectRegexMatches(SANDBOX_EXEC_TOKEN_RE, 'sandbox_exec');
  collectRegexMatches(TEMP_PATH_GLOBAL_RE, 'temp_path');

  return matches;
}

