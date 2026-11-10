import type { ToolSchema } from '../../../protocol/tools';

export const listExpertsSchema: ToolSchema = {
  name: 'list_experts',
  description:
    'List the authoritative local expert roster that can be used to form a team, or load a single persistent expert\'s current definition when `name` is provided. Call this before drafting a team or editing an existing role; do not use Bash or Glob to inspect the filesystem and guess roles.',
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Optional role name (roleId). When provided, returns the current definition of that persistent expert from the current slot instead of the full roster.',
      },
    },
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
