// ============================================================================
// RemindersCreate (P0-6.3 Batch 5 — connectors: native ToolModule rewrite)
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { normalizeReminderCreateTime } from '../../reminderCreateTime';
import { getConnectorRegistry } from '../../../connectors';
import {
  appleScriptFailureLogDetail,
  describeAppleScriptFailure,
  isAppleScriptFailure,
} from '../../../connectors/native/osascript';
import { createFailedReceiptArtifact, createVirtualArtifact } from '../../artifacts/artifactMeta';
import { remindersCreateSchema as schema } from './remindersCreate.schema';
import { formatConnectorTime } from './connectorTime';

const RECONCILE_LIMIT = 200;
const REMIND_AT_TOLERANCE_MS = 60_000;
const NO_BASH_RETRY_ONCE_GUIDANCE =
  'Do not work around this by running osascript or AppleScript through Bash or any script; at most retry reminders_create once or tell the user.';
const NO_BASH_NO_RETRY_GUIDANCE =
  'Do not work around this by running osascript or AppleScript through Bash or any script; do not retry reminders_create blindly and tell the user.';

interface CreatedReminder {
  id: string;
  list: string;
  title: string;
  completed: boolean;
  notes?: string;
  remindAtMs?: number | null;
}

function buildRemindersCreateSuccessResult(
  reminder: CreatedReminder,
  args: Record<string, unknown>,
  ctx: ToolContext,
  reconciledNote?: string,
): ToolResult<string> {
  const undoMetadata = reminder.id
    ? { undoable: true as const }
    : {
        undoable: false as const,
        undoUnavailableReason: 'Created reminder did not return a stable id.',
      };
  ctx.logger.debug('reminders_create', { list: reminder.list, title: reminder.title });
  const notes = typeof args.notes === 'string' ? args.notes : '';
  // Only the connector's read-back is authoritative, including an explicit null.
  const remindAtMs = typeof reminder.remindAtMs === 'number' && Number.isFinite(reminder.remindAtMs)
    ? reminder.remindAtMs : null;
  let remindAtText: string;
  if (remindAtMs !== null) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    }).formatToParts(new Date(remindAtMs));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
    remindAtText = `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}（${part('weekday')}，${timeZone}）`;
  } else {
    remindAtText = reminder.remindAtMs === null ? '未设置' : '无法确认，请在提醒事项中查看';
  }
  const baseOutput = `已创建提醒：\n- [${reminder.list}] ${reminder.title}${reminder.completed ? ' (completed)' : ''}\n提醒时间：${remindAtText}`;
  const output = reconciledNote ? `${baseOutput}\n${reconciledNote}` : baseOutput;

  return {
    ok: true,
    output,
    meta: {
      action: 'create_reminder',
      connector: 'reminders',
      id: reminder.id,
      ...undoMetadata,
      list: reminder.list,
      title: reminder.title,
      completed: reminder.completed,
      remindAtMs,
      notes,
      previewItem: {
        kind: 'reminder',
        title: reminder.title,
        subtitle: reminder.list,
        status: reminder.completed ? 'applied' : 'ready',
        content: {
          text: [
            `[${reminder.list}] ${reminder.title}`,
            remindAtText ? `提醒时间：${remindAtText}` : null,
            notes ? `备注：${notes}` : null,
          ].filter(Boolean).join('\n'),
          summary: remindAtText ? `${reminder.list} · ${remindAtText}` : reminder.list,
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
        name: `已创建提醒：${reminder.title}`,
        mimeType: 'text/markdown',
        contentLength: output.length,
        preview: output.slice(0, 500),
        metadata: {
          connector: 'reminders',
          action: 'create_reminder',
          id: reminder.id,
          ...undoMetadata,
          list: reminder.list,
          title: reminder.title,
          completed: reminder.completed,
          remindAtMs,
        },
      }),
    },
  };
}

function buildRemindersCreateFailureResult(
  failure: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  code?: string,
): ToolResult<string> {
  return {
    ok: false,
    error: failure,
    // AppleScript 失败码随结果下发（与 calendar.ts 同形；classify 的 perm_automation
    // 判据读 metadata.code，缺了它 reminders_create 的授权被拒发不出环境卡片）。
    ...(code ? { code } : {}),
    meta: {
      action: 'create_reminder',
      connector: 'reminders',
      list: args.list,
      title: args.title,
      failureReason: failure,
      artifact: createFailedReceiptArtifact({
        sourceTool: schema.name,
        sessionId: ctx.sessionId,
        action: 'create_reminder',
        name: `创建提醒失败：${String(args.title)}`,
        error: failure,
        metadata: { connector: 'reminders', list: args.list, title: args.title },
      }),
    },
  };
}

function normalizeSanitizedReminderText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\r\n|[|\r\n\t]/g, ' ').trim();
}

function matchesExpectedReminder(item: CreatedReminder, args: Record<string, unknown>): boolean {
  if (item.completed) return false;
  const expectedTitle = normalizeSanitizedReminderText(args.title);
  if (normalizeSanitizedReminderText(item.title) !== expectedTitle) return false;
  const expectedNotes = normalizeSanitizedReminderText(args.notes);
  if (expectedNotes !== '') {
    if (normalizeSanitizedReminderText(item.notes) !== expectedNotes) return false;
  }
  if (typeof args.remind_at_ms === 'number' && Number.isFinite(args.remind_at_ms)) {
    if (typeof item.remindAtMs !== 'number' || !Number.isFinite(item.remindAtMs)) return false;
    if (Math.abs(item.remindAtMs - args.remind_at_ms) > REMIND_AT_TOLERANCE_MS) return false;
  }
  return true;
}

async function executeRemindersCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  if (typeof args.title !== 'string' || args.title.length === 0) {
    return { ok: false, error: 'title must be a non-empty string', code: 'INVALID_ARGS' };
  }

  const reminderTime = normalizeReminderCreateTime(schema.name, args);
  if (!reminderTime.ok) return reminderTime;
  args = reminderTime.args;

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const connector = getConnectorRegistry().get('reminders');
  if (!connector) {
    return { ok: false, error: 'Reminders connector is not available.', code: 'NOT_INITIALIZED' };
  }

  try {
    const result = await connector.execute('create_reminder', args);
    const reminder = result.data as CreatedReminder;
    return buildRemindersCreateSuccessResult(reminder, args, ctx);
  } catch (error) {
    if (!isAppleScriptFailure(error)) {
      const failure = `Reminders create failed: ${error instanceof Error ? error.message : String(error)}`;
      return buildRemindersCreateFailureResult(failure, args, ctx);
    }

    const described = describeAppleScriptFailure('Reminders', error);
    ctx.logger.warn('reminders_create osascript failed', {
      connector: 'reminders',
      code: described.code,
      detail: appleScriptFailureLogDetail(error),
    });

    let items: CreatedReminder[];
    try {
      const listResult = await connector.execute('list_reminders', {
        list: args.list,
        limit: RECONCILE_LIMIT,
      });
      items = Array.isArray(listResult?.data) ? (listResult.data as CreatedReminder[]) : [];
    } catch (listError) {
      ctx.logger.warn('reminders_create reconcile list_reminders failed', {
        connector: 'reminders',
        detail: appleScriptFailureLogDetail(listError),
      });
      const failure = `${described.message} Creation could not be confirmed because listing reminders failed; do not retry blindly, ask the user to check the Reminders list. ${NO_BASH_NO_RETRY_GUIDANCE}`;
      return buildRemindersCreateFailureResult(failure, args, ctx, described.code);
    }

    const matched = items.find((item) => matchesExpectedReminder(item, args));
    if (matched) {
      return buildRemindersCreateSuccessResult(
        matched,
        args,
        ctx,
        'Note: the create command reported an error, but the reminder already exists in Reminders and was not created again.',
      );
    }

    if (items.length >= RECONCILE_LIMIT) {
      const failure = `${described.message} Creation could not be confirmed because the list returned ${RECONCILE_LIMIT} reminders (may be truncated); do not retry blindly, ask the user to check the Reminders list. ${NO_BASH_NO_RETRY_GUIDANCE}`;
      return buildRemindersCreateFailureResult(failure, args, ctx, described.code);
    }

    const failure = `${described.message} Nothing was created. ${NO_BASH_RETRY_ONCE_GUIDANCE}`;
    return buildRemindersCreateFailureResult(failure, args, ctx, described.code);
  }
}

class RemindersCreateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeRemindersCreate(args, ctx, canUseTool, onProgress);
  }
}

export const remindersCreateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new RemindersCreateHandler();
  },
};
