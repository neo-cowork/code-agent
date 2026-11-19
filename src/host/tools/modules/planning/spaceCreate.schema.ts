import type { ToolSchema } from '../../../protocol/tools';

export const spaceCreateSchema: ToolSchema = {
  name: 'space_create',
  description:
    'Create a Neo Space for durable shared work, configured capabilities, activity, and artifacts. ' +
    'Use this only when the user explicitly wants a new Space. This is a write operation and requires approval.',
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Human-readable Space name.',
      },
      description: {
        type: 'string',
        description: 'Optional purpose and scope of the Space.',
      },
      workspacePath: {
        type: 'string',
        description: 'Optional absolute project directory to bind and trust for this space.',
      },
      trustAcknowledged: {
        type: 'boolean',
        description: 'Set true only after the user acknowledges risky files reported by the folder trust gate.',
      },
    },
    required: ['name'],
  },
  category: 'planning',
  permissionLevel: 'write',
  readOnly: false,
  accesses: [
    { kind: 'write', expression: 'resource(space, args.name)' },
    { kind: 'write', expression: 'workspaceFile(args.workspacePath)' },
  ],
};
