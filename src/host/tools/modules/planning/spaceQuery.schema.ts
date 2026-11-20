import type { ToolSchema } from '../../../protocol/tools';

export const spaceQuerySchema: ToolSchema = {
  name: 'space_query',
  description:
    'Read one Neo Space as an aggregate: cloud members, selected experts, skills, connectors, automations, recent activity, and artifacts. ' +
    'Use it after space_list when you need the configured people, capabilities, work history, or deliverables for a specific space.',
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Space projectId returned by space_list.',
      },
    },
    required: ['projectId'],
  },
  category: 'planning',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
