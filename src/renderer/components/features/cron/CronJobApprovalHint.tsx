import React, { useRef, useState } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AwaitingApprovalRun } from '@shared/contract/sessionAutomation';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import ipcService from '../../../services/ipcService';
import { Button } from '../../primitives/Button';
import { awaitingApprovalLabel } from './awaitingApprovalLabel';

interface CronJobApprovalHintProps {
  run: AwaitingApprovalRun;
  onReview?: () => void;
  onResolved?: () => Promise<void>;
}

export const CronJobApprovalHint: React.FC<CronJobApprovalHintProps> = ({ run, onReview, onResolved }) => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const [busy, setBusy] = useState(false);
  const resolving = useRef(false);

  const resolve = async (response: 'allow' | 'deny') => {
    if (resolving.current) return;
    resolving.current = true;
    setBusy(true);
    try {
      const result = (await ipcService.invoke(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, run.requestId, response, run.sessionId,
      )) as { outcome?: string; orphaned?: boolean } | undefined;
      if (result && (result.orphaned === true || (result.outcome && result.outcome !== 'delivered'))) {
        toast.info(cc.parkedResolveStale);
      }
    } catch {
      toast.error(cc.parkedResolveFailed);
    } finally {
      try {
        await onResolved?.();
      } finally {
        resolving.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-badge-warning/30 bg-amber-500/5 px-3 py-2"
      data-testid="cron-detail-awaiting-approval-hint"
    >
      <span className="text-xs text-zinc-400">
        {awaitingApprovalLabel(cc, run) ?? cc.awaitingApprovalHint}
      </span>
      <Button type="button" variant="primary" size="sm" disabled={busy}
        onClick={() => { void resolve('allow'); }} data-testid="cron-detail-parked-approve">
        {cc.parkedApprove}
      </Button>
      <Button type="button" variant="secondary" size="sm" disabled={busy}
        onClick={() => { void resolve('deny'); }} data-testid="cron-detail-parked-reject">
        {cc.parkedReject}
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={busy}
        onClick={onReview} data-testid="cron-detail-awaiting-approval-action">
        {cc.awaitingApprovalAction}
      </Button>
    </div>
  );
};
