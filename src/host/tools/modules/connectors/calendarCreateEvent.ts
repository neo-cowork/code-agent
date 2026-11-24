// ============================================================================
// CalendarCreateEvent (P0-6.3 Batch 6 — connectors: native ToolModule rewrite)
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getHostConnectorCopy } from '../../../../shared/i18n/hostConnectorCopy';
import { stripCalendarReceiptUid } from '../../../../shared/utils/calendarReceiptText';
import { getHostUiLocale } from '../../../config/hostUiLocale';
import { getConnectorRegistry } from '../../../connectors';
import { formatConnectorUnavailableMessage } from './connectorStatusText';
import { createFailedReceiptArtifact, createVirtualArtifact } from '../../artifacts/artifactMeta';
import { calendarFailureCode, describeCalendarFailureForUser, describeCalendarWriteFailure } from './appleScriptWriteFailure';
import { calendarCreateEventSchema as schema } from './calendarCreateEvent.schema';
import { formatConnectorTime } from './connectorTime';
import { normalizeCalendarEventTime } from '../../calendarEventTime';

async function executeCalendarCreateEvent(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  if (typeof args.title !== 'string' || args.title.length === 0) {
    return { ok: false, error: 'title must be a non-empty string', code: 'INVALID_ARGS' };
  }
  const eventTime = normalizeCalendarEventTime(schema.name, args);
  if (!eventTime.ok) return eventTime;
  args = eventTime.args;
  if (typeof args.start_ms !== 'number') {
    return { ok: false, error: 'start_local (YYYY-MM-DD HH:mm, host-local) or start_ms is required', code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const connector = getConnectorRegistry().get('calendar');
  if (!connector) {
    return { ok: false, error: formatConnectorUnavailableMessage('calendar', 'create'), code: 'NOT_INITIALIZED' };
  }

  const { separator, calendar: copy } = getHostConnectorCopy(getHostUiLocale());
  try {
    const result = await connector.execute('create_event', args);
    const event = result.data as {
      uid: string;
      calendar: string;
      title: string;
      startAtMs: number | null;
      endAtMs: number | null;
      location?: string;
      notes?: string;
    };
    const undoMetadata = event.uid
      ? { undoable: true as const }
      : {
          undoable: false as const,
          undoUnavailableReason: 'Created calendar event did not return a stable uid.',
        };
    ctx.logger.debug('calendar_create_event', { calendar: event.calendar, title: event.title });
    const startText = event.startAtMs ? formatConnectorTime(event.startAtMs) : copy.unknown;
    const endText = event.endAtMs ? formatConnectorTime(event.endAtMs) : copy.unknown;
    // uid 必须给模型：真机第三轮模型拿不到它，照着别的日程拼了一个假 uid 去改（uid 与 list/update/delete 同一种形式）
    const output = `${copy.created}${separator.trimEnd()}\n- [${event.calendar}] ${event.title}${event.uid ? `\n- uid: ${event.uid}` : ''}\n- ${copy.start}${separator}${startText}\n- ${copy.end}${separator}${endText}${event.location ? `\n- ${copy.location}${separator}${event.location}` : ''}${event.notes ? `\n- ${copy.notes}${separator}${event.notes}` : ''}`;

    return {
      ok: true,
      output,
      meta: {
        action: 'create_event',
        connector: 'calendar',
        uid: event.uid,
        ...undoMetadata,
        calendar: event.calendar,
        title: event.title,
        startAtMs: event.startAtMs,
        endAtMs: event.endAtMs,
        location: event.location,
        previewItem: {
          kind: 'calendar_event',
          title: event.title,
          subtitle: event.calendar,
          status: 'ready',
          content: {
            text: [
              `[${event.calendar}] ${event.title}`,
              `${copy.start}${separator}${startText}`,
              `${copy.end}${separator}${endText}`,
              event.location ? `${copy.location}${separator}${event.location}` : null,
            ].filter(Boolean).join('\n'),
            summary: `${startText} · ${event.calendar}`,
          },
          actions: [
            { kind: 'copy', label: 'Copy' },
            { kind: 'open', label: 'Open' },
          ],
          priority: 80,
        },
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'text',
          role: 'receipt',
          sessionId: ctx.sessionId,
          name: copy.withTime(`${copy.created}${separator}${event.title}`, startText),
          mimeType: 'text/markdown',
          contentLength: output.length,
          preview: stripCalendarReceiptUid(output).slice(0, 500),
          metadata: {
            connector: 'calendar',
            action: 'create_event',
            uid: event.uid,
            ...undoMetadata,
            calendar: event.calendar,
            title: event.title,
            startAtMs: event.startAtMs,
            endAtMs: event.endAtMs,
          },
        }),
      },
    };
  } catch (error) {
    const failure = describeCalendarWriteFailure(
      'Calendar create failed',
      error,
      ctx.logger,
      schema.name,
    );
    const title = args.title;
    const failureName = title ? `${copy.createFailed}${separator}${title}` : copy.createFailed;
    const userMessage = describeCalendarFailureForUser(copy, error);
    return {
      ok: false,
      error: failure,
      userMessage,
      ...calendarFailureCode(error),
      meta: {
        action: 'create_event',
        connector: 'calendar',
        calendar: args.calendar,
        title: args.title,
        startAtMs: args.start_ms,
        failureReason: failure,
        artifact: createFailedReceiptArtifact({
          sourceTool: schema.name,
          sessionId: ctx.sessionId,
          action: 'create_event',
          name: failureName,
          preview: `${failureName}${separator}${userMessage}`,
          error: failure,
          metadata: { connector: 'calendar', calendar: args.calendar, title: args.title },
        }),
      },
    };
  }
}

class CalendarCreateEventHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeCalendarCreateEvent(args, ctx, canUseTool, onProgress);
  }
}

export const calendarCreateEventModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new CalendarCreateEventHandler();
  },
};
