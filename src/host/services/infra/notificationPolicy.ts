import { humanizeInternalText } from '../../../shared/humanizeInternalText';
import { presentReplyBody } from '../../../shared/replyBodyPresentation';
import { readUiLanguage } from '../../session/sessionTitleHostPrompt';
// ============================================================================
// Notification Policy Gate
// ============================================================================

import { scrubUserFacingText } from '../../security/userFacingError';

export type NotificationIntent =
  | 'needs_input'
  | 'task_complete'
  | 'task_failed'
  | 'task_resuming'
  | 'plugin'
  | 'progress'
  | 'typing'
  | 'stream_delta'
  | 'tool_started'
  | 'channel_reply';

export interface NotificationPolicyDecision {
  allowed: boolean;
  reason: string;
}

const ALLOWED_SYSTEM_NOTIFICATION_INTENTS = new Set<NotificationIntent>([
  'needs_input',
  'task_complete',
  'task_failed',
  'task_resuming',
  'plugin',
]);

export function evaluateNotificationPolicy(intent: NotificationIntent): NotificationPolicyDecision {
  if (ALLOWED_SYSTEM_NOTIFICATION_INTENTS.has(intent)) {
    return { allowed: true, reason: 'User intervention or terminal task state.' };
  }
  return { allowed: false, reason: 'Progress and channel surface updates stay in their own surface.' };
}

/** OS banners render plain text only: keep the words, drop Markdown syntax. */
function stripMarkdownForBanner(text: string): string {
  return text
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^(\s*\d+)\.\s+/gm, '$1. ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|`/g, '');
}

export function sanitizeNotificationText(value: unknown, maxLength = 240): string {
  const language = readUiLanguage();
  const body = presentReplyBody(String(value ?? ''), language).text;
  const plain = humanizeInternalText(stripMarkdownForBanner(body), language).text;
  const full = scrubUserFacingText(plain, {
    surface: 'desktop_notification',
    maxLength: Math.max(maxLength * 4, 1000),
  });
  if (full.length <= maxLength) return full;
  return `${full.slice(0, Math.max(maxLength - 1, 1)).trimEnd()}…`;
}
