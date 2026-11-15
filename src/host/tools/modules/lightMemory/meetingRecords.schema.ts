import type { ToolSchema } from '../../../protocol/tools';

export const meetingRecordsSchema: ToolSchema = {
  name: 'meeting_records',
  stepLabel: { default: 'meetingRecords' },
  description: `Read the user's past meetings stored in Agent Neo: meetings recorded with "记这场会" and imported Feishu Minutes / Tencent Meeting transcripts, with their minutes (decisions, action items, open questions).

Use it when the user asks about a past meeting ("上周那场会定了什么", "谁说要跟进报价"), or when you need a meeting's transcript to write minutes.
- action "list": recent meetings (id, title, time, source, minutes status).
- action "search": keyword search over titles, minutes and transcripts; returns matching snippets with the meeting id.
- action "read": one meeting by meeting_id — its minutes and full transcript (long meetings are cut at a length limit; the result says so).
Quote the transcript when you cite what someone said. Do not invent owners or due dates that the transcript does not state.`,
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'search', 'read'], description: 'What to do. Defaults to "list".' },
      query: { type: 'string', description: 'Keyword for action "search".' },
      meeting_id: { type: 'string', description: 'Meeting id for action "read" (from list or search).' },
      limit: { type: 'number', minimum: 1, description: 'Max meetings or hits to return (default 10, max 20).' },
    },
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  // 转写是会上其他人说的话，不是用户本人的指令：保留原文、标注来源（block 会把整份转写挡掉）
  readsUntrustedContent: 'annotate',
  allowInPlanMode: true,
};
