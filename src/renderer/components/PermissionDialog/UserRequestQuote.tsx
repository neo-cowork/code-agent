import React from 'react';
import type { PermissionRequest } from '../../../shared/contract/permission';

type QuoteDetails = Pick<PermissionRequest['details'], 'userRequest' | 'startedByAutomation' | 'startedByFirstWake' | 'scheduledTaskName'>;

interface UserRequestQuoteProps {
  details: QuoteDetails;
  labels: { userRequestQuote: string; startedByScheduledTask: string; startedByScheduledTaskGeneric: string; startedByFirstWake: string };
}

/** Scheduled-task name rendered in `scheduled-task-origin`, or `undefined` when that line is not shown. */
export function scheduledTaskOriginName(
  details: QuoteDetails,
): string | undefined {
  if (details.userRequest?.text || details.startedByFirstWake) return undefined;
  if (details.startedByAutomation) return details.scheduledTaskName?.trim() || undefined;
  return undefined;
}

/** Host-quoted user words (or the automatic origin) so the user can check the action is theirs. */
export function UserRequestQuote({ details, labels }: UserRequestQuoteProps) {
  if (details.startedByFirstWake) {
    return (
      <p data-testid="first-wake-origin" className="break-words text-sm text-zinc-300">
        {labels.startedByFirstWake}
      </p>
    );
  }
  const quote = details.userRequest;
  if (quote?.text) {
    return (
      <p data-testid="user-request-quote" className="break-words text-sm text-zinc-300">
        {labels.userRequestQuote.replace('{text}', quote.truncated ? `${quote.text}…` : quote.text)}
      </p>
    );
  }
  if (details.startedByAutomation) {
    const name = details.scheduledTaskName?.trim();
    return (
      <p data-testid="scheduled-task-origin" className="break-words text-sm text-zinc-300">
        {name ? labels.startedByScheduledTask.replace('{name}', name) : labels.startedByScheduledTaskGeneric}
      </p>
    );
  }
  return null;
}
