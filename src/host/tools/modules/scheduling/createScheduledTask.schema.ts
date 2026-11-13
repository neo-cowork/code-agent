import type { ToolSchema } from '../../../protocol/tools';

export const createScheduledTaskSchema: ToolSchema = {
  name: 'create_scheduled_task',
  description: 'Create a local scheduled automation after the user reviews and confirms it. '
    + 'Use for explicit requests to create a scheduled task, recurring work, or recurring reminders '
    + '(e.g. 帮我建一个定时任务, 每天早上9点提醒我交报告, create a weekly report task), or a one-off automated run. '
    + 'Do not use for questions, debugging existing jobs, analyzing daily/weekly data now, or listing/editing/pausing tasks. '
    + 'For data analysis, a time phrase alone is NOT a scheduling request: require an explicit request to schedule or automate FUTURE runs. '
    + 'When the user asks to check/summarize data they sent, analyze that data now or ask for the missing data; never turn missing input into a future automation. '
    + 'If it is ambiguous whether a time phrase describes supplied data or future runs, ask one clarifying question before calling this tool. '
    + 'Recurring reminder directives do count as explicit future-run requests. '
    + 'A plain one-off personal reminder belongs to the reminders connector unless the user asks for an automated task. '
    + 'Use this instead of Bash/crontab or Reminders for Neo automations. Never claim creation until the tool succeeds. '
    + 'Tasks run locally while Neo is running; this does not grant file, connector, or login permissions.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short user-facing task name, in the user’s language.' },
      prompt: { type: 'string', description: 'Complete instructions for each future run, not instructions to create another schedule.' },
      cron: { type: 'string', description: 'For recurring tasks: five-field cron (minute hour day month weekday), e.g. 0 9 * * * for daily 09:00. Preserve exact requested time. Provide exactly one of cron or at.' },
      timezone: { type: 'string', description: 'IANA timezone for cron. Omit to use this machine’s timezone; never guess a different timezone.' },
      at: { type: 'string', description: 'For a one-off run: future ISO 8601 datetime resolved against the current date. Omit the UTC offset for local wall time (e.g. 2026-12-01T15:00:00); the host uses this machine’s timezone. Include an offset or Z ONLY if the user specified that timezone. Never guess an offset. Provide exactly one of cron or at.' },
    },
    required: ['name', 'prompt'],
    additionalProperties: false,
  },
  outputSchema: { type: 'string' },
  category: 'planning',
  permissionLevel: 'write',
  readOnly: false,
  // Handler requests one mandatory confirmation after validating the actual schedule.
  requiresPermission: false,
  allowInPlanMode: false,
  allowInTextForeground: true,
  accesses: [{ kind: 'write', expression: 'resource(cron, jobs)' }],
  touchesWorkDirectory: false,
};
