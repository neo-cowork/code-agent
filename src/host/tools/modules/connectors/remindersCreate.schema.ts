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

Use this only when the user wants to create a real local reminder.`,
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
        description: 'Optional reminder time in Unix milliseconds.',
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
