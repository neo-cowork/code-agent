import type { ToolSchema } from '../../../protocol/tools';

export const feishuMinutesSearchSchema: ToolSchema = {
  name: 'feishuMinutesSearch',
  stepLabel: { default: 'feishuMinutesSearch' },
  description: `Search the user's Feishu Minutes (飞书妙记) through the Feishu connector (read only), by keyword and/or time window.

Each result shows the title, owner, start time, duration and the minute token. Pass the token (or the minutes URL) to feishuMinutesRead for the transcript, AI summary and todos.`,
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keyword in the title or content.' },
      start: { type: 'string', description: 'Time lower bound, ISO 8601 or YYYY-MM-DD.' },
      end: { type: 'string', description: 'Time upper bound, ISO 8601 or YYYY-MM-DD.' },
      page_size: { type: 'number', minimum: 1, description: 'Results per page, at most 30. Defaults to 15.' },
      page_token: { type: 'string', description: 'page_token from the previous response.' },
    },
  },
  category: 'mcp',
  permissionLevel: 'read',
  readOnly: true,
  readsUntrustedContent: 'annotate',
  allowInPlanMode: true,
};
