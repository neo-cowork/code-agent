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
- remind_at_ms

Use this only when the user wants to create a real local reminder.
Resolve relative dates using Today's date and Local timezone in <env> (the host-local zone used by Reminders.app). Do not use the UTC date as the local date. Convert the requested wall-clock time to Unix milliseconds in that zone; account for its UTC offset on the target date, including daylight saving.
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
      remind_at_ms: {
        type: 'number',
        description: 'Optional reminder instant in Unix milliseconds, corresponding to the requested local wall-clock time in the host-local timezone shown in <env>. Respect the target date UTC offset (including DST). Quote the success receipt time in your final reply.',
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
