import React from 'react';
import { Button } from '../../primitives/Button';
import { useDelegationRetry } from '../../../hooks/useDelegationRetry';
import { useI18n } from '../../../hooks/useI18n';
import { deleteIncompleteFileNames } from '../../../utils/agentFailureCopy';

interface DeleteIncompleteActionsProps {
  sessionId?: string;
  attemptId: string;
  endedAt?: number;
  leftoverPaths?: readonly string[];
  openSession?: boolean;
}

export function DeleteIncompleteActions({
  sessionId,
  attemptId,
  endedAt,
  leftoverPaths,
  openSession,
}: DeleteIncompleteActionsProps) {
  const { t } = useI18n();
  const copy = t.delegationFailedActions;
  const files = deleteIncompleteFileNames(leftoverPaths) || copy.remainingFiles;
  const retry = useDelegationRetry(sessionId, `delete-incomplete-retry-${attemptId}-`, endedAt, openSession);
  const actions = [
    { label: copy.retry, draft: copy.deleteRetryDraft },
    { label: copy.tryAnotherWay, draft: copy.deleteAnotherWayDraft },
  ];

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="delete-incomplete-actions">
      {actions.map(({ label, draft }) => (
        <Button
          key={draft}
          variant="ghost"
          size="sm"
          disabled={retry.disabled}
          title={retry.showBusyHint ? copy.retryBusy : undefined}
          onClick={() => { void retry.send(draft.replace('{files}', () => files)); }}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}
