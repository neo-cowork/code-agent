import React from 'react';
import type { PermissionRequest } from '../../../shared/contract/permission';

interface UserRequestQuoteProps {
  details: PermissionRequest['details'];
  labels: { userRequestQuote: string; startedByScheduledTask: string };
}

/** Scheduled-task name rendered in `scheduled-task-origin`, or `undefined` when that line is not shown. */
export function scheduledTaskOriginName(
  details: Pick<PermissionRequest['details'], 'userRequest' | 'startedByAutomation' | 'purpose'>,
): string | undefined {
  if (details.userRequest?.text) return undefined;
  if (details.startedByAutomation && details.purpose) return details.purpose;
  return undefined;
}

/** Host-quoted user words (or the scheduled-task origin) so the user can check the action is theirs. */
export function UserRequestQuote({ details, labels }: UserRequestQuoteProps) {
  const quote = details.userRequest;
  if (quote?.text) {
    return (
      <p data-testid="user-request-quote" className="break-words text-sm text-zinc-300">
        {labels.userRequestQuote.replace('{text}', quote.truncated ? `${quote.text}…` : quote.text)}
      </p>
    );
  }
  const originName = scheduledTaskOriginName(details);
  if (originName) {
    return (
      <p data-testid="scheduled-task-origin" className="break-words text-sm text-zinc-300">
        {labels.startedByScheduledTask.replace('{name}', originName)}
      </p>
    );
  }
  return null;
}
