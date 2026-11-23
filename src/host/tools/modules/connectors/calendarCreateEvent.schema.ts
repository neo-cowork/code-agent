// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const calendarCreateEventSchema: ToolSchema = {
  name: 'calendar_create_event',
  description: `Create a new event in macOS Calendar via the native connector.

Required parameters:
- title
- start_local (preferred) or start_ms

Optional parameters:
- calendar
- end_local (preferred) or end_ms
- location
- notes

Use this only when the user wants to create a real local calendar event.
Resolve relative dates using Today's date and Local timezone in <env> (the host-local zone used by Calendar.app). Do not use the UTC date as the local date. Give times as start_local / end_local in YYYY-MM-DD HH:mm (24-hour) form in that local timezone. The host converts them to the actual instant, including daylight saving; never do epoch arithmetic for these fields. Supply only one time form per field (start_local or start_ms, end_local or end_ms).`,
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
      start_local: {
        type: 'string',
        description: 'Preferred event start: local wall-clock YYYY-MM-DD HH:mm (24-hour) in the user local timezone shown in <env>, which is the host-local zone used by Calendar.app. Never an epoch, UTC time, or offset-bearing string. Resolve tomorrow/day-after-tomorrow using the local date in <env>. Nonexistent DST wall-clock times are rejected.',
      },
      end_local: {
        type: 'string',
        description: 'Preferred event end, same local wall-clock YYYY-MM-DD HH:mm format as start_local. Defaults to start + 30 minutes.',
      },
      start_ms: {
        type: 'number',
        description: 'Optional existing Unix-millisecond instant. Prefer start_local for user wall-clock requests to avoid epoch arithmetic. Do not supply both start_local and start_ms.',
      },
      end_ms: {
        type: 'number',
        description: 'Optional existing Unix-millisecond instant. Prefer end_local. Do not supply both end_local and end_ms. Defaults to start + 30 minutes.',
      },
      location: {
        type: 'string',
        description: 'Optional event location.',
      },
      notes: {
        type: 'string',
        description: 'Optional event notes / description shown in Calendar.app. Pass the user wording as-is, in the user language.',
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
