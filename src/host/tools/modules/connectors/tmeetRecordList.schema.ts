import type { ToolSchema } from '../../../protocol/tools';

export const tmeetRecordListSchema: ToolSchema = {
  name: 'tmeetRecordList',
  stepLabel: { default: 'tmeetRecordList' },
  description: `List Tencent Meeting cloud recordings and text transcriptions through the official tmeet CLI (read only).

Give a time window (start + end), or a meeting_id / meeting_code. Each result shows the meeting subject, meeting id, start time, recording type and its record_file_id(s). Pass a record_file_id to tmeetRecordRead to get the transcript and smart minutes. Meetings hosted by someone else may list no record files when the user has no view permission.`,
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      start: { type: 'string', description: 'Window start, ISO 8601 with timezone, e.g. 2026-11-10T00:00+08:00. Use together with end.' },
      end: { type: 'string', description: 'Window end, ISO 8601 with timezone.' },
      meeting_id: { type: 'string', description: 'Tencent meeting id (from tmeetMeetingList / tmeetMeetingSearch).' },
      meeting_code: { type: 'string', pattern: '^\\d+$', description: 'Meeting code, digits only.' },
      page_token: { type: 'string', description: 'next_page_token from the previous response.' },
    },
  },
  category: 'mcp',
  permissionLevel: 'read',
  readOnly: true,
  readsUntrustedContent: 'annotate',
  allowInPlanMode: true,
};
