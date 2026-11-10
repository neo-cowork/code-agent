// ============================================================================
// Native Reminders Connector - macOS Reminders via AppleScript
// ============================================================================

import type { Connector, ConnectorExecutionResult, ConnectorStatus } from '../base';
import {
  buildAppleScriptDateVar,
  describeAppleScriptFailure,
  escapeAppleScriptString,
  isAppleScriptFailure,
  parseAppleScriptDate,
  runAppleScript,
  sharedAppleScriptHandlers,
} from './osascript';

interface ReminderItem {
  id: string;
  list: string;
  title: string;
  completed: boolean;
  notes?: string;
  remindAtMs?: number | null;
}

type NativeReadiness = 'unchecked' | 'ready' | 'failed' | 'unavailable';

function initialRemindersReadiness(): NativeReadiness {
  return process.platform === 'darwin' ? 'unchecked' : 'unavailable';
}

let remindersReadiness: NativeReadiness = initialRemindersReadiness();
let remindersProbeError: string | undefined;
let remindersProbeCheckedAt: number | undefined;
// 最近一次探测拿到的提醒列表是否为空（授权通过但无列表）——getStatus 的
// ready 分支作为 noAccessibleItems 结构化信号下发，渲染层不做文案匹配
let remindersProbeListEmpty = false;

export function resetRemindersConnectorReadiness(): void {
  remindersReadiness = initialRemindersReadiness();
  remindersProbeError = undefined;
  remindersProbeCheckedAt = undefined;
  remindersProbeListEmpty = false;
}

function markRemindersReadReady(noAccessibleLists = false): void {
  remindersReadiness = 'ready';
  remindersProbeCheckedAt = Date.now();
  remindersProbeError = undefined;
  remindersProbeListEmpty = noAccessibleLists;
}

function parseLine(line: string): string[] {
  return line.split('|').map((part) => part.trim());
}

function errorMessage(error: unknown): string {
  return isAppleScriptFailure(error)
    ? describeAppleScriptFailure('Reminders', error).message
    : error instanceof Error ? error.message : String(error);
}

function buildRemindersStatus(capabilities: string[]): ConnectorStatus {
  if (process.platform !== 'darwin') {
    return {
      connected: false,
      readiness: 'unavailable',
      detail: 'Reminders connector 仅在 macOS 可用。',
      actions: [],
      capabilities,
    };
  }

  if (remindersReadiness === 'ready') {
    return {
      connected: true,
      readiness: 'ready',
      checkedAt: remindersProbeCheckedAt,
      detail: 'Reminders connector 已通过本地授权/可用性检查。',
      noAccessibleItems: remindersProbeListEmpty,
      actions: ['disconnect', 'remove'],
      capabilities,
    };
  }

  if (remindersReadiness === 'failed') {
    return {
      connected: false,
      readiness: 'failed',
      error: remindersProbeError,
      checkedAt: remindersProbeCheckedAt,
      detail: `Reminders 授权/可用性检查失败：${remindersProbeError || '未知错误'}`,
      actions: ['repair_permissions', 'disconnect', 'remove'],
      capabilities,
    };
  }

  return {
    connected: false,
    readiness: 'unchecked',
    detail: 'Reminders connector 已启用，但还未检查本地授权；点“检查/授权”时才会拉起 Reminders 或触发系统授权。',
    actions: ['repair_permissions', 'disconnect', 'remove'],
    capabilities,
  };
}

async function listReminderLists(): Promise<string[]> {
  const output = await runAppleScript([
    ...sharedAppleScriptHandlers(),
    'tell application "Reminders"',
    'set outputLines to {}',
    'repeat with reminderList in every list',
    'set end of outputLines to my sanitizeText(name of reminderList)',
    'end repeat',
    'return my joinLines(outputLines)',
    'end tell',
  ]);

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveReminderListName(requestedName: string, availableLists: string[]): string {
  const exactMatch = availableLists.find((name) => name === requestedName);
  if (exactMatch) return exactMatch;

  const caseInsensitiveMatches = availableLists.filter(
    (name) => name.toLowerCase() === requestedName.toLowerCase(),
  );
  if (caseInsensitiveMatches.length === 1) return caseInsensitiveMatches[0];

  const availableText = availableLists.length > 0 ? availableLists.join(', ') : '(none)';
  throw new Error(
    `No reminder list named "${requestedName}". Available lists: ${availableText}. Omit list to use the default list.`,
  );
}

async function probeRemindersAccess(): Promise<string[]> {
  if (process.platform !== 'darwin') {
    remindersReadiness = 'unavailable';
    remindersProbeCheckedAt = Date.now();
    remindersProbeError = 'Reminders connector 仅在 macOS 可用。';
    throw new Error(remindersProbeError);
  }

  try {
    const lists = await listReminderLists();
    markRemindersReadReady(lists.length === 0);
    return lists;
  } catch (error) {
    remindersReadiness = 'failed';
    remindersProbeCheckedAt = Date.now();
    remindersProbeError = errorMessage(error);
    throw error;
  }
}

async function listReminders(payload: Record<string, unknown>): Promise<ReminderItem[]> {
  const listName = typeof payload.list === 'string' ? payload.list.trim() : '';
  const includeCompleted = payload.include_completed === true;
  const limit = typeof payload.limit === 'number' ? payload.limit : 20;

  const lines = [
    ...sharedAppleScriptHandlers(),
    'tell application "Reminders"',
    'set outputLines to {}',
    `set reminderLimit to ${Math.max(1, Math.min(limit, 200))}`,
    'set emittedCount to 0',
  ];

  if (listName) {
    lines.push(`set targetLists to {list "${escapeAppleScriptString(listName)}"}`);
  } else {
    lines.push('set targetLists to every list');
  }

  const reminderQuery = includeCompleted
    ? '(every reminder of reminderList)'
    : '(every reminder of reminderList whose completed is false)';
  lines.push(
    'repeat with reminderList in targetLists',
    'set reminderListName to my sanitizeText(name of reminderList)',
    // Fetch values in bulk; the item loop below only formats local AppleScript lists.
    `set {reminderIds, reminderNames, reminderCompleted} to {id, name, completed} of ${reminderQuery}`,
    'set reminderBodies to {}',
    'try',
    `set reminderBodies to body of ${reminderQuery}`,
    'end try',
    'set reminderDates to {}',
    'try',
    `set reminderDates to remind me date of ${reminderQuery}`,
    'end try',
    'repeat with reminderIndex from 1 to count of reminderIds',
    'set rawNotes to ""',
    'if reminderIndex <= (count of reminderBodies) then set rawNotes to item reminderIndex of reminderBodies',
    'set reminderNotes to my sanitizeText(rawNotes)',
    'set rawRemindDate to missing value',
    'if reminderIndex <= (count of reminderDates) then set rawRemindDate to item reminderIndex of reminderDates',
    'set remindDateText to my isoDateText(rawRemindDate)',
    'set reminderLine to (item reminderIndex of reminderIds as text) & "|" & reminderListName & "|" & (my sanitizeText(item reminderIndex of reminderNames)) & "|" & (item reminderIndex of reminderCompleted as text) & "|" & reminderNotes & "|" & remindDateText',
    'set end of outputLines to reminderLine',
    'set emittedCount to emittedCount + 1',
    'if emittedCount >= reminderLimit then exit repeat',
    'end repeat',
    'if emittedCount >= reminderLimit then exit repeat',
    'end repeat',
    'return my joinLines(outputLines)',
    'end tell'
  );

  const output = await runAppleScript(lines);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, list, title, completedRaw, notes, remindAtRaw] = parseLine(line);
      return {
        id,
        list,
        title,
        completed: completedRaw === 'true',
        notes: notes || undefined,
        remindAtMs: parseAppleScriptDate(remindAtRaw),
      } satisfies ReminderItem;
    });
}

async function getReminder(payload: Record<string, unknown>): Promise<ReminderItem> {
  const listName = typeof payload.list === 'string' ? payload.list.trim() : '';
  const reminderId = typeof payload.reminder_id === 'string' ? payload.reminder_id.trim() : '';

  if (!listName) {
    throw new Error('list is required for get_reminder');
  }
  if (!reminderId) {
    throw new Error('reminder_id is required for get_reminder');
  }

  const output = await runAppleScript([
    ...sharedAppleScriptHandlers(),
    'tell application "Reminders"',
    `tell list "${escapeAppleScriptString(listName)}"`,
    `set targetReminder to first reminder whose id is "${escapeAppleScriptString(reminderId)}"`,
    'set rawNotes to ""',
    'try',
    'set rawNotes to body of targetReminder',
    'end try',
    'set rawRemindDate to missing value',
    'try',
    'set rawRemindDate to remind me date of targetReminder',
    'end try',
    `return (id of targetReminder as text) & "|" & (my sanitizeText("${escapeAppleScriptString(listName)}")) & "|" & (my sanitizeText(name of targetReminder)) & "|" & (completed of targetReminder as text) & "|" & (my sanitizeText(rawNotes)) & "|" & (my isoDateText(rawRemindDate))`,
    'end tell',
    'end tell',
  ]);

  const [id, list, title, completedRaw, notes, remindAtRaw] = parseLine(output);
  return {
    id,
    list,
    title,
    completed: completedRaw === 'true',
    notes: notes || undefined,
    remindAtMs: parseAppleScriptDate(remindAtRaw),
  };
}

async function createReminder(payload: Record<string, unknown>): Promise<ReminderItem> {
  const requestedListName = typeof payload.list === 'string' ? payload.list.trim() : '';
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';
  const remindAtMs = typeof payload.remind_at_ms === 'number' ? payload.remind_at_ms : undefined;

  if (!title) {
    throw new Error('title is required for create_reminder');
  }
  const listName = requestedListName
    ? resolveReminderListName(requestedListName, await listReminderLists())
    : '';

  const lines = [
    ...sharedAppleScriptHandlers(),
  ];

  if (typeof remindAtMs === 'number' && Number.isFinite(remindAtMs)) {
    lines.push(...buildAppleScriptDateVar('remindDate', remindAtMs));
  }

  lines.push(
    'tell application "Reminders"',
    ...(listName
      ? [`tell list "${escapeAppleScriptString(listName)}"`]
      : ['set targetList to default list', 'tell targetList']),
    `set newReminder to make new reminder with properties {name:"${escapeAppleScriptString(title)}"}`,
  );

  if (notes) {
    lines.push(`set body of newReminder to "${escapeAppleScriptString(notes)}"`);
  }
  if (typeof remindAtMs === 'number' && Number.isFinite(remindAtMs)) {
    lines.push('set remind me date of newReminder to remindDate');
  }

  lines.push(
    `return (id of newReminder as text) & "|" & ${listName ? `(my sanitizeText("${escapeAppleScriptString(listName)}"))` : '(my sanitizeText(name of targetList))'} & "|" & (my sanitizeText(name of newReminder)) & "|" & (completed of newReminder as text)`,
    'end tell',
    'end tell'
  );

  const output = await runAppleScript(lines);
  const [id, list, parsedTitle, completedRaw] = parseLine(output);
  return {
    id,
    list,
    title: parsedTitle,
    completed: completedRaw === 'true',
  };
}

async function updateReminder(payload: Record<string, unknown>): Promise<ReminderItem> {
  const listName = typeof payload.list === 'string' ? payload.list.trim() : '';
  const reminderId = typeof payload.reminder_id === 'string' ? payload.reminder_id.trim() : '';
  const hasTitle = typeof payload.title === 'string';
  const title = hasTitle ? (payload.title as string).trim() : '';
  const hasNotes = Object.prototype.hasOwnProperty.call(payload, 'notes') && typeof payload.notes === 'string';
  const notes = hasNotes ? (payload.notes as string) : '';
  const hasCompleted = typeof payload.completed === 'boolean';
  const completed = hasCompleted ? payload.completed : false;
  const hasRemindAt = typeof payload.remind_at_ms === 'number' && Number.isFinite(payload.remind_at_ms);
  const remindAtMs = hasRemindAt ? payload.remind_at_ms as number : undefined;
  const clearRemindAt = payload.clear_remind_at === true;

  if (!listName) {
    throw new Error('list is required for update_reminder');
  }
  if (!reminderId) {
    throw new Error('reminder_id is required for update_reminder');
  }
  if (!hasTitle && !hasNotes && !hasCompleted && !hasRemindAt && !clearRemindAt) {
    throw new Error('at least one field must be provided for update_reminder');
  }

  const lines = [
    ...sharedAppleScriptHandlers(),
  ];

  if (typeof remindAtMs === 'number') {
    lines.push(...buildAppleScriptDateVar('remindDate', remindAtMs));
  }

  lines.push(
    'tell application "Reminders"',
    `tell list "${escapeAppleScriptString(listName)}"`,
    `set targetReminder to first reminder whose id is "${escapeAppleScriptString(reminderId)}"`,
  );

  if (hasTitle && title) {
    lines.push(`set name of targetReminder to "${escapeAppleScriptString(title)}"`);
  }
  if (hasNotes) {
    lines.push(`set body of targetReminder to "${escapeAppleScriptString(notes)}"`);
  }
  if (typeof remindAtMs === 'number') {
    lines.push('set remind me date of targetReminder to remindDate');
  }
  if (clearRemindAt) {
    lines.push('set remind me date of targetReminder to missing value');
  }
  if (hasCompleted) {
    lines.push(`set completed of targetReminder to ${completed ? 'true' : 'false'}`);
  }

  lines.push(
    `return (id of targetReminder as text) & "|" & (my sanitizeText("${escapeAppleScriptString(listName)}")) & "|" & (my sanitizeText(name of targetReminder)) & "|" & (completed of targetReminder as text)`,
    'end tell',
    'end tell',
  );

  const output = await runAppleScript(lines);
  const [id, list, parsedTitle, completedRaw] = parseLine(output);
  return {
    id,
    list,
    title: parsedTitle,
    completed: completedRaw === 'true',
  };
}

async function deleteReminder(payload: Record<string, unknown>): Promise<{
  id: string;
  list: string;
  title: string;
  deleted: boolean;
}> {
  const listName = typeof payload.list === 'string' ? payload.list.trim() : '';
  const reminderId = typeof payload.reminder_id === 'string' ? payload.reminder_id.trim() : '';

  if (!listName) {
    throw new Error('list is required for delete_reminder');
  }
  if (!reminderId) {
    throw new Error('reminder_id is required for delete_reminder');
  }

  const output = await runAppleScript([
    ...sharedAppleScriptHandlers(),
    'tell application "Reminders"',
    `tell list "${escapeAppleScriptString(listName)}"`,
    `set targetReminder to first reminder whose id is "${escapeAppleScriptString(reminderId)}"`,
    'set reminderTitle to my sanitizeText(name of targetReminder)',
    'delete targetReminder',
    'return reminderTitle',
    'end tell',
    'end tell',
  ]);

  return {
    id: reminderId,
    list: listName,
    title: output,
    deleted: true,
  };
}

export const remindersConnector: Connector = {
  id: 'reminders',
  label: 'Reminders',
  capabilities: ['get_status', 'list_lists', 'list_reminders', 'create_reminder', 'update_reminder', 'delete_reminder'],
  getCachedStatus(): ConnectorStatus {
    return buildRemindersStatus(this.capabilities);
  },
  async getStatus(): Promise<ConnectorStatus> {
    return buildRemindersStatus(this.capabilities);
  },
  async execute(action: string, payload: Record<string, unknown>): Promise<ConnectorExecutionResult> {
    switch (action) {
      case 'get_status':
        return { data: await this.getStatus() };
      case 'probe_access': {
        const lists = await probeRemindersAccess();
        return {
          data: await this.getStatus(),
          summary: lists.length > 0
            ? `Reminders 授权/可用性检查通过，可访问 ${lists.length} 个列表`
            : 'Reminders 授权/可用性检查通过，但没有找到可访问的提醒列表',
        };
      }
      case 'repair_permissions': {
        resetRemindersConnectorReadiness();
        const lists = await probeRemindersAccess();
        return {
          data: await this.getStatus(),
          summary: lists.length > 0
            ? `Reminders 权限修复检查通过，可访问 ${lists.length} 个列表`
            : 'Reminders 权限修复检查通过，但没有找到可访问的提醒列表',
        };
      }
      case 'disconnect':
      case 'remove':
        resetRemindersConnectorReadiness();
        return {
          data: await this.getStatus(),
          summary: action === 'disconnect' ? 'Reminders connector 已断开。' : 'Reminders connector 已移除。',
        };
      case 'list_lists': {
        const lists = await listReminderLists();
        markRemindersReadReady(lists.length === 0);
        return {
          data: lists,
          summary: lists.length > 0 ? `找到 ${lists.length} 个提醒列表` : '没有找到可访问的提醒列表',
        };
      }
      case 'list_reminders': {
        const reminders = await listReminders(payload);
        markRemindersReadReady();
        return {
          data: reminders,
          summary: reminders.length > 0 ? `找到 ${reminders.length} 条提醒` : '没有找到匹配的提醒',
        };
      }
      case 'get_reminder': {
        const reminder = await getReminder(payload);
        markRemindersReadReady();
        return {
          data: reminder,
          summary: `找到提醒：${reminder.title}`,
        };
      }
      case 'create_reminder': {
        const reminder = await createReminder(payload);
        return {
          data: reminder,
          summary: `已创建提醒：${reminder.title}`,
        };
      }
      case 'update_reminder': {
        const reminder = await updateReminder(payload);
        return {
          data: reminder,
          summary: `已更新提醒：${reminder.title}`,
        };
      }
      case 'delete_reminder': {
        const reminder = await deleteReminder(payload);
        return {
          data: reminder,
          summary: `已删除提醒：${reminder.title}`,
        };
      }
      default:
        throw new Error(`Unsupported reminders action: ${action}`);
    }
  },
};
