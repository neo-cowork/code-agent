import type { Message } from '@shared/contract';

export interface FailureRun {
  cause: string;
  latestId: string;
  runLength: number;
}

export function isSuccessfulAssistantReply(message: Message): boolean {
  return message.role === 'assistant' && !message.isMeta
    && !message.metadata?.agentError && !message.metadata?.backgroundTaskPreannounce
    && !message.toolCalls?.length && Boolean(message.content?.trim());
}

/** Surfaces decide when success/completion is eligible to reset and how causes are derived. */
export function failureRunStep(
  current: FailureRun | undefined,
  event: { type: 'reset' } | { type: 'failure'; cause: string | undefined; id: string },
): { run: FailureRun | undefined; supersededId?: string } {
  if (event.type === 'reset' || event.cause === undefined) return { run: undefined };
  const continues = current?.cause === event.cause;
  return {
    run: { cause: event.cause, latestId: event.id, runLength: continues ? current.runLength + 1 : 1 },
    supersededId: continues ? current.latestId : undefined,
  };
}
