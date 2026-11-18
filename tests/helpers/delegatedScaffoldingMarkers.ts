// Internal scaffolding of the delegated task prompt: it must reach the model, never a stored user row.
export const DELEGATED_SCAFFOLDING_MARKERS = ['<drafted_task_plan>', '<original_user_request', 'This task covers only'] as const;
