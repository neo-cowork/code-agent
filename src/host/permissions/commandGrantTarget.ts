import { redactCommandSecrets } from '../security/secretRedaction';

export function usesCommand24hGrant(tool: string): boolean {
  return tool === 'terminal_write' || tool === 'Process';
}

function commandTargetText(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === 'terminal_write') {
    return typeof args.input === 'string' && args.input.length > 0 ? args.input : undefined;
  }
  if (tool !== 'Process') return undefined;
  const { action, session_id: sessionId, task_id: taskId, data, input } = args;
  if (action === 'kill') {
    const id = sessionId ?? taskId;
    return typeof id === 'string' && id.length > 0 ? `kill:${id}` : undefined;
  }
  const payload = action === 'write' ? data : action === 'submit' ? input : undefined;
  if (typeof sessionId !== 'string' || !sessionId || typeof payload !== 'string') return undefined;
  // Quote the id so separators within the id or payload cannot collide.
  return `${action}:${JSON.stringify(sessionId)}:${payload}`;
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

const TERMINAL_GRANT_PREFIX = 'terminal:';

/** The input is the visible scope. The storage key also binds where and how it was approved. */
export function commandGrantKey(
  tool: string,
  target: string | null | undefined,
  sessionId: string | undefined,
  args: Record<string, unknown>,
): string | undefined {
  if (!target) return undefined;
  if (tool !== 'terminal_write') return target;
  if (!sessionId) return undefined;
  const explicit = args.session_id;
  const terminalId = typeof explicit === 'string' && explicit.length > 0 ? explicit : sessionId;
  return TERMINAL_GRANT_PREFIX + JSON.stringify([sessionId, terminalId, args.pressEnter !== false, target]);
}

export function commandGrantDisplayTarget(tool: string, target: string): string {
  if (tool !== 'terminal_write' || !target.startsWith(TERMINAL_GRANT_PREFIX)) return target;
  try {
    const scope: unknown = JSON.parse(target.slice(TERMINAL_GRANT_PREFIX.length));
    return Array.isArray(scope) && typeof scope[3] === 'string' ? scope[3] : target;
  } catch {
    return target;
  }
}
