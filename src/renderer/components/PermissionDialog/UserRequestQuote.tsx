import React from 'react';
import type { PermissionRequest } from '../../../shared/contract/permission';

interface UserRequestQuoteProps {
  details: PermissionRequest['details'];
  labels: { userRequestQuote: string; startedByScheduledTask: string };
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
  if (details.startedByAutomation && details.purpose) {
    return (
      <p data-testid="scheduled-task-origin" className="break-words text-sm text-zinc-300">
        {labels.startedByScheduledTask.replace('{name}', details.purpose)}
      </p>
    );
  }
  return null;
}
