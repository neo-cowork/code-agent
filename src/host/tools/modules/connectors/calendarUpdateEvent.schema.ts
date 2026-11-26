// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const calendarUpdateEventSchema: ToolSchema = {
  name: 'calendar_update_event',
  description: `Update an existing event in macOS Calendar via the native connector.

Required parameters:
- calendar
- event_uid

Optional parameters:
- title
- start_local (preferred) or start_ms
- end_local (preferred) or end_ms
- location

Use this only when the user wants to modify a real local calendar event.
Resolve relative dates using Today's date and Local timezone in <env> (the host-local zone used by Calendar.app). Do not use the UTC date as the local date. Give new times as start_local / end_local in YYYY-MM-DD HH:mm (24-hour) form in that local timezone. The host converts them to the actual instant, including daylight saving; never do epoch arithmetic for these fields. If only the start (start_local / start_ms) is given, the event keeps its duration and the end moves with it; to change the length, give both start and end. Supply only one time form per field (start_local or start_ms, end_local or end_ms).`,
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      calendar: {
        type: 'string',
        description: 'Target calendar name.',
      },
      event_uid: {
        type: 'string',
        description: 'Stable Calendar event uid.',
      },
      title: {
        type: 'string',
        description: 'Optional updated title.',
      },
      start_local: {
        type: 'string',
        description: 'Preferred updated start: local wall-clock YYYY-MM-DD HH:mm (24-hour) in the user local timezone shown in <env>, which is the host-local zone used by Calendar.app. Never an epoch, UTC time, or offset-bearing string. Nonexistent DST wall-clock times are rejected.',
      },
      end_local: {
        type: 'string',
        description: 'Preferred updated end, same local wall-clock YYYY-MM-DD HH:mm format as start_local.',
      },
      start_ms: {
        type: 'number',
        description: 'Optional existing Unix-millisecond instant. Prefer start_local for user wall-clock requests. Do not supply both start_local and start_ms.',
      },
      end_ms: {
        type: 'number',
        description: 'Optional existing Unix-millisecond instant. Prefer end_local. Do not supply both end_local and end_ms.',
      },
      location: {
        type: 'string',
        description: 'Optional updated location. Pass an empty string to clear it.',
      },
    },
    required: ['calendar', 'event_uid'],
  },
  category: 'mcp',
  permissionLevel: 'write',
  readOnly: false,
  touchesWorkDirectory: false,
  allowInPlanMode: false,
};
