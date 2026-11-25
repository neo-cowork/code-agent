import { redactCommandSecrets } from '../security/secretRedaction';

export function usesCommand24hGrant(tool: string): boolean {
  return tool === 'terminal_write' || tool === 'Process';
}

function commandTargetText(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === 'terminal_write') {
    return typeof args.input === 'string' && args.input.length > 0 ? args.input : undefined;
  }
  if (tool !== 'Process') return undefined;
  const { action, session_id, task_id, data, input } = args;
  if (action === 'kill') {
    const id = session_id ?? task_id;
    return typeof id === 'string' && id.length > 0 ? `kill:${id}` : undefined;
  }
  const payload = action === 'write' ? data : action === 'submit' ? input : undefined;
  if (typeof session_id !== 'string' || !session_id || typeof payload !== 'string') return undefined;
  // Quote the id so separators within the id or payload cannot collide.
  return `${action}:${JSON.stringify(session_id)}:${payload}`;
}

/** undefined: unsupported arguments. null: exact text cannot be persisted safely. */
export function commandGrantTarget(tool: string, args: Record<string, unknown>): string | null | undefined {
  const text = commandTargetText(tool, args);
  if (text === undefined) return undefined;
  // Test the raw parameters too, before JSON escaping can obscure a credential.
  const containsSecret = [text, args.session_id, args.task_id, args.input, args.data]
    .some((part) => typeof part === 'string' && redactCommandSecrets(part) !== part);
  return containsSecret || /\p{Surrogate}/u.test(text) ? null : text;
}
