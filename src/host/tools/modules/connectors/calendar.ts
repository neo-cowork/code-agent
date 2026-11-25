// ============================================================================
// Calendar (P0-6.3 Batch 6 — connectors: native ToolModule rewrite)
// ============================================================================

import { getHostConnectorCopy } from '../../../../shared/i18n/hostConnectorCopy';
import { getHostUiLocale } from '../../../config/hostUiLocale';
import { stripCalendarListUids } from '../../../../shared/utils/connectorReceiptText';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { normalizeCalendarListWindow } from '../../calendarEventTime';
import { getConnectorRegistry } from '../../../connectors';
import { isCalendarFailure } from '../../../connectors/native/calendar';
import { createVirtualArtifact } from '../../artifacts/artifactMeta';
import { calendarSchema as schema } from './calendar.schema';
import { formatConnectorStatusOutput, formatConnectorUnavailableMessage } from './connectorStatusText';
import type { NativeConnectorDetailCode } from '../../../../shared/ipc/types';
import { describeCalendarFailureForUser } from './appleScriptWriteFailure';
import { formatConnectorNow, formatConnectorTime } from './connectorTime';

type CalendarAction = 'get_status' | 'list_calendars' | 'list_events';

interface CalendarEvent {
  calendar: string;
  title: string;
  startAtMs: number | null;
  endAtMs: number | null;
  location?: string;
  uid?: string;
}

function formatEvent(event: CalendarEvent, copy: ReturnType<typeof getHostConnectorCopy>['calendar']): string {
  const start = event.startAtMs ? formatConnectorTime(event.startAtMs) : copy.unknownStart;
  const end = event.endAtMs ? formatConnectorTime(event.endAtMs) : copy.unknownEnd;
  const location = event.location ? ` | ${event.location}` : '';
  const uid = event.uid ? `\n  uid: ${event.uid}` : '';
  return `- [${event.calendar}] ${event.title}\n  ${start} -> ${end}${location}${uid}`;
}

function buildCalendarMeta(
  ctx: ToolContext,
  action: string,
  output: string,
  metadata: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  return {
    action,
    connector: 'calendar',
    ...metadata,
    artifact: createVirtualArtifact({
      sourceTool: schema.name,
      kind: 'text',
      sessionId: ctx.sessionId,
      name,
      mimeType: 'text/markdown',
      contentLength: output.length,
      preview: stripCalendarListUids(output).slice(0, 500),
      metadata: {
        connector: 'calendar',
        action,
        ...metadata,
      },
    }),
  };
}

async function executeCalendar(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const action = args.action;
  if (typeof action !== 'string') {
    return { ok: false, error: 'action must be a string', code: 'INVALID_ARGS' };
  }
  const allowed: CalendarAction[] = ['get_status', 'list_calendars', 'list_events'];
  if (!allowed.includes(action as CalendarAction)) {
    return { ok: false, error: `Unsupported calendar action: ${action}`, code: 'INVALID_ARGS' };
  }

  let connectorArgs = args;
  if (action === 'list_events') {
    const window = normalizeCalendarListWindow(args);
    if (!window.ok) return window;
    connectorArgs = window.args;
  }

  // Ask about the normalized window the connector will actually read.
  const permit = await canUseTool(schema.name, connectorArgs);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const locale = getHostUiLocale();
  const catalog = getHostConnectorCopy(locale);
  const { separator, calendar: copy } = catalog;
  const connector = getConnectorRegistry().get('calendar');
  if (!connector) {
    if (action === 'get_status') {
      const status = {
        connected: false,
        detail: 'Calendar connector is not configured in this runtime.',
        capabilities: [] as string[],
        unavailable: true,
      };
      const output = formatConnectorStatusOutput('calendar', status);
      return {
        ok: true,
        output,
        meta: buildCalendarMeta(ctx, action, output, { status }, copy.read.status),
      };
    }
    return { ok: false, error: formatConnectorUnavailableMessage('calendar', 'read'), code: 'NOT_INITIALIZED' };
  }

  try {
    const result = await connector.execute(action, connectorArgs);
    ctx.logger.debug('calendar', { action });

    if (action === 'get_status') {
      const status = result.data as { connected: boolean; detail?: string; detailCode?: NativeConnectorDetailCode; capabilities: string[] };
      const output = formatConnectorStatusOutput('calendar', status);
      return {
        ok: true,
        output,
        meta: buildCalendarMeta(ctx, action, output, { status }, copy.read.status),
      };
    }

    if (action === 'list_calendars') {
      const calendars = result.data as string[];
      const output = calendars.length > 0
        ? `${copy.read.collections} (${calendars.length})${separator.trimEnd()}\n- ${calendars.join('\n- ')}`
        : copy.read.emptyCollections;
      return {
        ok: true,
        output,
        meta: buildCalendarMeta(ctx, action, output, { count: calendars.length, calendars }, copy.read.collections),
      };
    }

    // list_events
    const events = result.data as CalendarEvent[];
    const baseOutput = events.length > 0
      ? `${copy.read.items} (${events.length})${separator.trimEnd()}\n${events.map((event) => formatEvent(event, copy)).join('\n')}`
      : copy.read.emptyItems;
    const output = `${formatConnectorNow(undefined, undefined, locale)}\n${baseOutput}`;
    return {
      ok: true,
      output,
      meta: buildCalendarMeta(ctx, action, output, { count: events.length, events }, copy.read.items),
    };
  } catch (error) {
    // EventKit 失败带机器码（not_authorized 走授权卡 / 停车续做）；文案不含原生细节
    const calendarFailure = isCalendarFailure(error);
    ctx.logger.warn('calendar connector failed', {
      connector: 'calendar',
      code: calendarFailure ? error.code : 'connector_error',
    });
    return {
      ok: false,
      error: calendarFailure
        ? error.message
        : `Calendar connector failed: ${error instanceof Error ? error.message : String(error)}`,
      code: calendarFailure ? error.code : 'CONNECTOR_FAILED',
      ...(locale === 'en' ? { userMessage: describeCalendarFailureForUser(copy, separator, error) } : {}),
    };
  }
}

class CalendarHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeCalendar(args, ctx, canUseTool, onProgress);
  }
}

export const calendarModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new CalendarHandler();
  },
};
