// ============================================================================
// CalendarUpdateEvent (P0-6.3 Batch 6 — connectors: native ToolModule rewrite)
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
import { calendarUpdateEventSchema as schema } from './calendarUpdateEvent.schema';
import { captureCalendarBefore } from './undoMetadata';
import { formatConnectorTime } from './connectorTime';
import { normalizeCalendarEventTime } from '../../calendarEventTime';

async function executeCalendarUpdateEvent(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  if (typeof args.calendar !== 'string' || args.calendar.length === 0) {
    return { ok: false, error: 'calendar must be a non-empty string', code: 'INVALID_ARGS' };
  }
  if (typeof args.event_uid !== 'string' || args.event_uid.length === 0) {
    return { ok: false, error: 'event_uid must be a non-empty string', code: 'INVALID_ARGS' };
  }

  const eventTime = normalizeCalendarEventTime(schema.name, args);
  if (!eventTime.ok) return eventTime;
  args = eventTime.args;

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
    return { ok: false, error: formatConnectorUnavailableMessage('calendar', 'change'), code: 'NOT_INITIALIZED' };
  }

  const { separator, calendar: copy } = getHostConnectorCopy(getHostUiLocale());
  const undoMetadata = await captureCalendarBefore(connector, args);
  try {
    const result = await connector.execute('update_event', args);
    const event = result.data as {
      uid: string;
      calendar: string;
      title: string;
      startAtMs: number | null;
      endAtMs: number | null;
      location?: string;
    };
    ctx.logger.debug('calendar_update_event', { uid: event.uid, calendar: event.calendar });
    const startText = event.startAtMs ? formatConnectorTime(event.startAtMs) : copy.unknown;
    const endText = event.endAtMs ? formatConnectorTime(event.endAtMs) : copy.unknown;
    const output = `${copy.updated}${separator.trimEnd()}\n- [${event.calendar}] ${event.title}\n- uid: ${event.uid}\n- ${copy.start}${separator}${startText}\n- ${copy.end}${separator}${endText}${event.location ? `\n- ${copy.location}${separator}${event.location}` : ''}`;

    return {
      ok: true,
      output,
      meta: {
        action: 'update_event',
        connector: 'calendar',
        uid: event.uid,
        calendar: event.calendar,
        title: event.title,
        startAtMs: event.startAtMs,
        endAtMs: event.endAtMs,
        location: event.location,
        ...undoMetadata,
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'text',
          role: 'receipt',
          sessionId: ctx.sessionId,
          name: copy.withTime(`${copy.updated}${separator}${event.title}`, startText),
          mimeType: 'text/markdown',
          contentLength: output.length,
          preview: stripCalendarReceiptUid(output).slice(0, 500),
          metadata: {
            connector: 'calendar',
            action: 'update_event',
            uid: event.uid,
            calendar: event.calendar,
            title: event.title,
            ...undoMetadata,
          },
        }),
      },
    };
  } catch (error) {
    const failure = describeCalendarWriteFailure(
      'Calendar update failed',
      error,
      ctx.logger,
      schema.name,
    );
    const title = (typeof args.title === 'string' && args.title.trim()) || (undoMetadata.undoable && undoMetadata.before.title);
    const failureName = title ? `${copy.updateFailed}${separator}${title}` : copy.updateFailed;
    const userMessage = describeCalendarFailureForUser(copy, separator, error);
    return {
      ok: false,
      error: failure,
      userMessage,
      ...calendarFailureCode(error),
      meta: {
        action: 'update_event',
        connector: 'calendar',
        calendar: args.calendar,
        uid: args.event_uid,
        title: args.title,
        failureReason: failure,
        artifact: createFailedReceiptArtifact({
          sourceTool: schema.name,
          sessionId: ctx.sessionId,
          action: 'update_event',
          name: failureName,
          preview: `${failureName}${separator}${userMessage}`,
          error: failure,
          metadata: { connector: 'calendar', calendar: args.calendar, uid: args.event_uid, title: args.title },
        }),
      },
    };
  }
}

class CalendarUpdateEventHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeCalendarUpdateEvent(args, ctx, canUseTool, onProgress);
  }
}

export const calendarUpdateEventModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new CalendarUpdateEventHandler();
  },
};
