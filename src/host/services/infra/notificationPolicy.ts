import { humanizeInternalText } from '../../../shared/humanizeInternalText';
import { presentReplyBody } from '../../../shared/replyBodyPresentation';
import { readUiLanguage } from '../../session/sessionTitleHostPrompt';
import { PARKED_APPROVAL_ENTRY_PATH, PARKED_APPROVAL_ENTRY_PATH_EN } from '../../../shared/parkedApprovalLocation';
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

/** Approval notice copy in the UI language; every permission_request producer shares it. */
export function buildApprovalNoticeCopy(tool?: unknown, command?: unknown): { title: string; body: string } {
  const en = readUiLanguage() === 'en';
  const waiting = en ? 'needs your approval' : '请求执行权限';
  return {
    title: en ? 'Approval needed' : '需要授权',
    body: tool ? `${String(tool)}: ${command ? String(command) : waiting}` : en ? 'A request needs your approval' : waiting,
  };
}

/** Unattended (parked) approval notice in the UI language. */
export function buildParkedApprovalNoticeCopy(tool: string): { title: string; body: string } {
  return readUiLanguage() === 'en'
    ? {
      title: 'An action is waiting for you',
      body: `An unattended task wants to run ${tool} and is paused until you approve it under ${PARKED_APPROVAL_ENTRY_PATH_EN}.`,
    }
    : {
      title: '有操作等你确认',
      body: `无人值守任务请求执行 ${tool}，已暂停等你批准，到${PARKED_APPROVAL_ENTRY_PATH}处理。`,
    };
}

export function sanitizeNotificationText(value: unknown, maxLength = 240): string {
  const language = readUiLanguage();
  const body = presentReplyBody(String(value ?? ''), language).text;
  // Humanize before stripping markdown: `mcp__server__tool` would otherwise lose its `__` as bold markers
  // and reach the banner as an unrecognizable id.
  const plain = humanizeInternalText(stripMarkdownForBanner(humanizeInternalText(body, language).text), language).text;
  const full = scrubUserFacingText(plain, {
    surface: 'desktop_notification',
    maxLength: Math.max(maxLength * 4, 1000),
  });
  if (full.length <= maxLength) return full;
  return `${full.slice(0, Math.max(maxLength - 1, 1)).trimEnd()}…`;
}
