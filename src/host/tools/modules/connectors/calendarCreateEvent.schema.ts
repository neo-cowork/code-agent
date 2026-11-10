// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const calendarCreateEventSchema: ToolSchema = {
  name: 'calendar_create_event',
  description: `Create a new event in macOS Calendar via the native connector.

Required parameters:
- title
- start_ms

Optional parameters:
- calendar
- end_ms
- location

Use this only when the user wants to create a real local calendar event.`,
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      calendar: {
        type: 'string',
        description: 'Optional calendar name. Omit to use the first writable calendar. If given, use an existing localized name; call the list action first when unsure instead of guessing.',
      },
      title: {
        type: 'string',
        description: 'Event title.',
      },
      start_ms: {
        type: 'number',
        description: 'Event start time in Unix milliseconds.',
      },
      end_ms: {
        type: 'number',
        description: 'Event end time in Unix milliseconds. Defaults to start + 30 minutes.',
      },
      location: {
        type: 'string',
        description: 'Optional event location.',
      },
    },
    required: ['title', 'start_ms'],
  },
  category: 'mcp',
  permissionLevel: 'write',
  readOnly: false,
  touchesWorkDirectory: false,
  allowInPlanMode: false,
};
