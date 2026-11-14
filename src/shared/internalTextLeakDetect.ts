// 内部文案外露检测（N-UX-INTERNAL-TEXT-LEAK-SYSTEMIC-CORE）：humanizeInternalText 与 CI 门共用的检测器。
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
  | 'raw_json';

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

export const ENGLISH_STATE_REGEXES: RegExp[] = [
  new RegExp(leakPatterns.englishState[0], 'g'),
  new RegExp(leakPatterns.englishState[1], 'gi'),
  new RegExp(leakPatterns.englishState[2], 'gi'),
  new RegExp(leakPatterns.englishState[3], 'gi'),
  new RegExp(leakPatterns.englishState[4], 'gi'),
  new RegExp(leakPatterns.englishState[5], 'gi'),
  new RegExp(leakPatterns.englishState[6], 'gi'),
  new RegExp(leakPatterns.englishState[7], 'gi'),
];

export const SANDBOX_EXEC_COMMAND_RE = new RegExp(`${leakPatterns.sandboxExec}\\s+-f\\s+\\S+`, 'g');
export const SANDBOX_EXEC_TOKEN_RE = new RegExp(leakPatterns.sandboxExec, 'g');

export const TEMP_PATH_GLOBAL_RE = new RegExp(leakPatterns.tempPath, 'g');

export const INLINE_RAW_JSON_RE = new RegExp(`\\{(?:\\s*${leakPatterns.rawJsonKeyValue}\\s*,?){1,}\\}`, 'g');

/**
 * Inspect a user-visible string and return all internal-format leaks found.
 * Used both by the renderer humanizer and by the CI internal-text-leak gate.
 */
export function detectInternalTextLeaks(input: string): Array<{ format: InternalTextFormat; sample: string }> {
  if (!input?.trim()) return [];

  const matches: InternalTextLeakMatch[] = [];
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

