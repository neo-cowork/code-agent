import type { ToolSchema } from '../../../protocol/tools';

export const spaceListSchema: ToolSchema = {
  name: 'space_list',
  description:
    'List the user-created Spaces available in Neo, including recent activity. ' +
    'Use this when the user asks what Spaces exist or when you need a projectId before space_query.',
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {},
  },
  category: 'planning',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
