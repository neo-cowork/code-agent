import type { ToolSchema } from '../../../protocol/tools';

export const scheduleTaskSchema: ToolSchema = {
  name: 'schedule_task',
  description: 'Open a scheduled-task draft confirmation card for a new recurring or one-time task that Neo will execute later. Use for requests such as "every day at 9am summarize sales", "每周五汇总会议纪要，建成定时任务", or "schedule a one-time task tomorrow to export invoices". Pass the user’s own request including when and what. Nothing is created until the user confirms the card. Do not use for how-to questions, ordinary development work, failures, listing/deleting/enabling existing tasks, or a simple one-shot reminder to contact someone.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', minLength: 1, description: 'The user’s own request, including when to run and what Neo should do.' },
    },
    required: ['description'],
    additionalProperties: false,
  },
  outputSchema: { type: 'string' },
  category: 'planning',
  permissionLevel: 'read',
  readOnly: true,
  requiresPermission: false,
  allowInPlanMode: true,
  touchesWorkDirectory: false,
};
