// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const remindersCreateSchema: ToolSchema = {
  name: 'reminders_create',
  description: `Create a new reminder in macOS Reminders via the native connector.

Required parameters:
- title

Optional parameters:
- list
- notes
- remind_at_local (preferred)
- remind_at_ms

Use this only when the user wants to create a real local reminder.
Resolve relative dates using Today's date and Local timezone in <env> (the host-local zone used by Reminders.app). Do not use the UTC date as the local date. For timed reminders, prefer remind_at_local in YYYY-MM-DD HH:mm (24-hour) form in that local timezone. The host converts it to the actual instant, including daylight saving; never do epoch arithmetic for this field. Supply only one time field.
The success receipt reports the actual read-back reminder time. In your final reply, quote that receipt time verbatim, including its timezone; never recalculate it from the request or claim an unconfirmed time.`,
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      list: {
        type: 'string',
        description: 'Optional reminder list name. Omit to use the default list. If given, use an existing localized name; call the list action first when unsure instead of guessing.',
      },
      title: {
        type: 'string',
        description: 'Reminder title.',
      },
      notes: {
        type: 'string',
        description: 'Optional reminder notes/body.',
      },
      remind_at_local: {
        type: 'string',
        description: 'Preferred reminder time: local wall-clock YYYY-MM-DD HH:mm (24-hour) in the user local timezone shown in <env>, which is the host-local zone used by Reminders.app. Never an epoch, UTC time, or offset-bearing string. Resolve tomorrow/day-after-tomorrow using the local date in <env>. Nonexistent DST wall-clock times are rejected.',
      },
      remind_at_ms: {
        type: 'number',
        description: 'Optional existing Unix-millisecond instant. Prefer remind_at_local for user wall-clock requests to avoid epoch arithmetic. Do not supply both time fields. Quote the success receipt time in your final reply.',
      },
    },
    required: ['title'],
  },
  category: 'mcp',
  permissionLevel: 'write',
  readOnly: false,
  touchesWorkDirectory: false,
  allowInPlanMode: false,
};
