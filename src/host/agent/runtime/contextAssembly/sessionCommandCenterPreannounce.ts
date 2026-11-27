import { BACKGROUND_TASK_PREANNOUNCE } from '@shared/constants/backgroundTaskPreannounce';
import { truncateAtWordBoundary } from '../../../utils/truncate';
import { extractUserRequest } from '../../turnScaffold';
import type { ModelResponse } from '../../loopTypes';

export interface CommandCenterToolStartInput {
  toolName?: string;
  locale?: 'en' | 'zh';
  commandCenterEnabled: boolean;
  streamedContent: string;
  existingPreannounce: string;
  userMessage: string;
  emitPreview(text: string): void;
  emitToolStart(): void;
}

// If extraction leaves any scaffold tag, use generic copy rather than quoting system context.
const TURN_SCAFFOLD_TAG_PATTERN = /<\/?[a-z][\w-]*>/i;

const PREANNOUNCE_TITLE_CODE_POINTS = 28;

// Tool/shell words, snake_case identifiers, backtick spans and `$ ` prompt lines in the
// user's words would leak internal names into the quoted title (FB-3029) — generic copy instead.
const TOOL_OR_SHELL_WORD_PATTERN = /\b(?:bash|zsh|shell|terminal|osascript|applescript|powershell|curl|sudo)\b/i;
const SNAKE_CASE_IDENTIFIER_PATTERN = /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/;
const BACKTICK_SPAN_PATTERN = /`[^`]*`/;
const SHELL_PROMPT_LINE_PATTERN = /^[ \t]*\$ /m;

function looksLikeToolOrCommandText(request: string): boolean {
  return TOOL_OR_SHELL_WORD_PATTERN.test(request)
    || SNAKE_CASE_IDENTIFIER_PATTERN.test(request)
    || BACKTICK_SPAN_PATTERN.test(request)
    || SHELL_PROMPT_LINE_PATTERN.test(request);
}

function preannounceTitle(userMessage: string): string | undefined {
  const request = extractUserRequest(userMessage);
  const normalized = request.replace(/\s+/g, ' ').trim();
  if (!normalized || TURN_SCAFFOLD_TAG_PATTERN.test(normalized) || looksLikeToolOrCommandText(request)) {
    return undefined;
  }
  return truncateAtWordBoundary(normalized, PREANNOUNCE_TITLE_CODE_POINTS);
}

function buildCommandCenterPreannounce(userMessage: string, locale: 'en' | 'zh'): string {
  const title = preannounceTitle(userMessage);
  const copy = BACKGROUND_TASK_PREANNOUNCE[locale];
  return title ? copy.named.replace('{title}', title) : copy.generic;
}

/** Emits the renderer-visible preview before the pending tool row. */
export function emitCommandCenterToolStart(input: CommandCenterToolStartInput): string {
  let preannounce = input.existingPreannounce;
  if (
    input.toolName === 'delegate_task'
    && input.commandCenterEnabled
    && !input.streamedContent.trim()
    && !preannounce
  ) {
    preannounce = buildCommandCenterPreannounce(input.userMessage, input.locale ?? 'zh');
    input.emitPreview(preannounce);
  }
  input.emitToolStart();
  return preannounce;
}

export function applyCommandCenterPreannounce(
  response: ModelResponse,
  preannounce: string,
  userMessage = '',
): ModelResponse {
  if (!preannounce || response.type !== 'tool_use') return response;
  const delegates = response.toolCalls?.filter((call) => call.name === 'delegate_task');
  response.backgroundTaskPreannounce = {
    text: preannounce,
    title: preannounceTitle(userMessage),
    ...(delegates?.length === 1 ? { toolCallId: delegates[0].id } : {}),
  };
  const modelContent = response.content?.trim();
  response.content = modelContent ? `${preannounce}\n${modelContent}` : preannounce;
  response.contentParts = [
    { type: 'text', text: preannounce },
    ...(modelContent ? [{ type: 'text' as const, text: modelContent }] : []),
    ...(response.toolCalls ?? []).map((toolCall) => ({
      type: 'tool_call' as const,
      toolCallId: toolCall.id,
    })),
  ];
  return response;
}
