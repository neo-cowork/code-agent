import { BACKGROUND_TASK_PREANNOUNCE } from '@shared/constants/backgroundTaskPreannounce';
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

function preannounceTitle(userMessage: string): string | undefined {
  const request = extractUserRequest(userMessage).replace(/\s+/g, ' ').trim();
  if (!request || TURN_SCAFFOLD_TAG_PATTERN.test(request)) return undefined;
  return Array.from(request).slice(0, 28).join('') + (Array.from(request).length > 28 ? '…' : '');
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
  response.backgroundTaskPreannounce = { text: preannounce, title: preannounceTitle(userMessage) };
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
