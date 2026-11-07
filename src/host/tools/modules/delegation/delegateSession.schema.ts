import type { ToolSchema } from '../../../protocol/tools';

export const delegateSessionSchema: ToolSchema = {
  name: 'delegate_session',
  description: 'Delegate a task to another chat session, create a new session, or operate on an existing delegation. For delegate_existing, bind only when the user message singles out exactly one listed candidate and supplies task text. If several candidates fit, the named target is absent from the candidate list, or task text is missing, do not call delegate_session; call AskUserQuestion first. create_new is never a fallback for ambiguity. The model never supplies session ids or workspace paths; use list_session_candidates first.',
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['delegate_existing', 'create_new', 'correct', 'stop', 'resume'] },
      candidateSetId: { type: 'string' },
      candidateRef: { type: 'string' },
      text: { type: 'string' },
      delegationId: { type: 'string' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  category: 'planning',
  permissionLevel: 'execute',
  allowInTextForeground: true,
  accesses: [{ kind: 'write', expression: 'resource(session, delegation)' }],
};
