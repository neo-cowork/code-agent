// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';
import { CONNECTION_STATE_HONESTY } from './connectionStateHonesty';

export const calendarSchema: ToolSchema = {
  name: 'calendar',
  description: `Read macOS Calendar data via a native connector.

Supported actions:
- get_status
- list_calendars
- list_events

Use this for local calendar inspection in office workflows.
For list_events, use from_local / to_local for any user date range. Resolve relative dates using Today's date and Local timezone in <env> (the host-local zone used by Calendar.app). Do not use the UTC date as the local date. Give local timestamps only, not relative-range keywords; never compute epoch milliseconds. The host converts local times, including daylight saving. Legacy from_ms / to_ms remain accepted; when both forms of the same bound are given, the local field wins.

${CONNECTION_STATE_HONESTY}`,
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get_status', 'list_calendars', 'list_events'],
        description: 'Calendar action to perform.',
      },
      calendar: {
        type: 'string',
        description: 'Optional calendar name for list_events.',
      },
      from_local: {
        type: 'string',
        description: 'Preferred inclusive start for list_events: local wall-clock YYYY-MM-DD HH:mm (24-hour) in the user local timezone shown in <env>, which is the host-local zone used by Calendar.app. Never an epoch, UTC time, or offset-bearing string. Nonexistent DST wall-clock times are rejected. Takes priority over from_ms.',
      },
      to_local: {
        type: 'string',
        description: 'Preferred inclusive end for list_events, same local wall-clock YYYY-MM-DD HH:mm format as from_local. Takes priority over to_ms.',
      },
      from_ms: {
        type: 'number',
        description: 'Optional inclusive start timestamp in Unix milliseconds.',
      },
      to_ms: {
        type: 'number',
        description: 'Optional inclusive end timestamp in Unix milliseconds.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of events to return. Default: 20.',
      },
    },
    required: ['action'],
  },
  category: 'mcp',
  permissionLevel: 'read',
  readOnly: true,
  // Invite organizers (arbitrary external senders) control event title/location;
  // policy is per tool, so get_status/list_calendars ride the same declaration.
  readsUntrustedContent: 'block',
  allowInPlanMode: true,
};
