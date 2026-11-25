// ============================================================================
// Reminders (P0-6.3 Batch 5 — connectors: native ToolModule rewrite)
// ============================================================================

import { getHostConnectorCopy } from '../../../../shared/i18n/hostConnectorCopy';
import { getHostUiLocale } from '../../../config/hostUiLocale';
import { stripReminderRowIds } from '../../../../shared/utils/connectorReceiptText';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getConnectorRegistry } from '../../../connectors';
import type { Connector, ConnectorStatus } from '../../../connectors/base';
import {
  appleScriptFailureLogDetail,
  describeAppleScriptFailure,
  isAppleScriptFailure,
} from '../../../connectors/native/osascript';
import { createVirtualArtifact } from '../../artifacts/artifactMeta';
import { describeStatusDetail, formatConnectorStatus, formatConnectorUnavailableMessage } from './connectorStatusText';
import { formatConnectorNow, formatConnectorTime } from './connectorTime';
import { remindersSchema as schema } from './reminders.schema';

type RemindersAction = 'get_status' | 'list_lists' | 'list_reminders';
const pendingAccessProbes = new WeakMap<Connector, Promise<unknown>>();

interface ReminderItem {
  id: string | number;
  list: string;
  title: string;
  completed: boolean;
  remindAtMs?: number | null;
}

function formatReminder(
  reminder: ReminderItem,
  now: number,
  { separator, reminders: copy }: ReturnType<typeof getHostConnectorCopy>,
): string {
  const hasTime = typeof reminder.remindAtMs === 'number' && Number.isFinite(reminder.remindAtMs);
  const remindAt = hasTime
    ? `${copy.time}${separator}${formatConnectorTime(reminder.remindAtMs as number)}`
    : copy.noTime;
  // 到点状态由宿主按时刻比较给出，模型只转述，不自行推断。
  const dueState = hasTime && !reminder.completed
    ? ((reminder.remindAtMs as number) > now ? copy.dueLater : copy.overdue)
    : '';
  return `- #${reminder.id} [${reminder.list}] ${reminder.title}${reminder.completed ? ' (completed)' : ''} | ${remindAt}${dueState}`;
}

function buildRemindersMeta(
  ctx: ToolContext,
  action: string,
  output: string,
  metadata: Record<string, unknown>,
  name: string,
  modelGuidance?: string,
): Record<string, unknown> {
  return {
    action,
    connector: 'reminders',
    ...metadata,
    ...(modelGuidance ? { modelGuidance } : {}),
    artifact: createVirtualArtifact({
      sourceTool: schema.name,
      kind: 'text',
      sessionId: ctx.sessionId,
      name,
      mimeType: 'text/markdown',
      contentLength: output.length,
      preview: stripReminderRowIds(output).slice(0, 500),
      metadata: {
        connector: 'reminders',
        action,
        ...metadata,
      },
    }),
  };
}

async function executeReminders(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const action = args.action;
  if (typeof action !== 'string') {
    return { ok: false, error: 'action must be a string', code: 'INVALID_ARGS' };
  }
  const allowed: RemindersAction[] = ['get_status', 'list_lists', 'list_reminders'];
  if (!allowed.includes(action as RemindersAction)) {
    return { ok: false, error: `Unsupported reminders action: ${action}`, code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const locale = getHostUiLocale();
  const catalog = getHostConnectorCopy(locale);
  const { separator, reminders: copy } = catalog;
  const connector = getConnectorRegistry().get('reminders');
  if (!connector) {
    if (action === 'get_status') {
      const status = {
        connected: false,
        detail: 'Reminders connector is not configured in this runtime.',
        capabilities: [] as string[],
        unavailable: true,
      };
      const { output, guidance } = formatConnectorStatus('reminders', status);
      return {
        ok: true,
        output,
        meta: buildRemindersMeta(ctx, action, output, { status }, copy.read.status, guidance),
      };
    }
    return { ok: false, error: formatConnectorUnavailableMessage('reminders', 'read'), code: 'NOT_INITIALIZED' };
  }

  let probingAccess = false;
  try {
    if (connector.getCachedStatus?.().readiness === 'unchecked') {
      probingAccess = true;
      let probe = pendingAccessProbes.get(connector);
      if (!probe) {
        ctx.logger.debug('reminders', { action: 'probe_access', requestedAction: action });
        probe = connector.execute('probe_access', {}).finally(() => {
          pendingAccessProbes.delete(connector);
        });
        pendingAccessProbes.set(connector, probe);
      }
      await probe;
      probingAccess = false;
      if (ctx.abortSignal.aborted) {
        return { ok: false, error: 'aborted', code: 'ABORTED' };
      }
    }

    const result = await connector.execute(action, args);
    ctx.logger.debug('reminders', { action });

    if (action === 'get_status') {
      const status = result.data as ConnectorStatus;
      if (status.errorCode === 'not_authorized') {
        return {
          ok: false,
          code: status.errorCode,
          error: describeStatusDetail(status) || 'Reminders access denied',
          meta: { accessProbeDenied: true },
        };
      }
      const { output, guidance } = formatConnectorStatus('reminders', status);
      return {
        ok: true,
        output,
        meta: buildRemindersMeta(ctx, action, output, { status }, copy.read.status, guidance),
      };
    }

    if (action === 'list_lists') {
      const lists = result.data as string[];
      const output = lists.length > 0
        ? `${copy.read.collections} (${lists.length})${separator.trimEnd()}\n- ${lists.join('\n- ')}`
        : copy.read.emptyCollections;
      return {
        ok: true,
        output,
        meta: buildRemindersMeta(ctx, action, output, { count: lists.length, lists }, copy.read.collections),
      };
    }

    // list_reminders
    const reminders = result.data as ReminderItem[];
    const now = Date.now();
    const output = reminders.length > 0
      ? `${formatConnectorNow(now, undefined, locale)}\n${copy.read.items} (${reminders.length})${separator.trimEnd()}\n${reminders.map((r) => formatReminder(r, now, catalog)).join('\n')}`
      : copy.read.emptyItems;
    return {
      ok: true,
      output,
      meta: buildRemindersMeta(ctx, action, output, { count: reminders.length, reminders }, copy.read.items),
    };
  } catch (error) {
    const osascriptFailure = isAppleScriptFailure(error);
    const failure = describeAppleScriptFailure(
      'Reminders', error,
      !probingAccess && action === 'list_reminders' ? { timeoutContext: 'list_reminders' } : undefined,
    );
    ctx.logger.warn('reminders connector failed', {
      connector: 'reminders',
      code: osascriptFailure ? failure.code : 'connector_error',
      detail: appleScriptFailureLogDetail(error),
    });
    const displayMessage = failure.code === 'timeout' ? failure.message : catalog.appleScriptFailure[failure.code];
    const result: ToolResult<string> = {
      ok: false,
      error: osascriptFailure
        ? failure.message
        : `Reminders connector failed: ${error instanceof Error ? error.message : String(error)}`,
      code: osascriptFailure ? failure.code : 'CONNECTOR_FAILED',
      ...(locale === 'en' && failure.code !== 'not_authorized' ? { userMessage: displayMessage } : {}),
    };
    if (result.code === 'not_authorized') {
      result.meta = { accessProbeDenied: true };
    }
    return result;
  }
}

class RemindersHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeReminders(args, ctx, canUseTool, onProgress);
  }
}

export const remindersModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new RemindersHandler();
  },
};
