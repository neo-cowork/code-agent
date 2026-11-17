import React from 'react';
import type { AwaitingApprovalRun } from '@shared/contract/sessionAutomation';
import { useI18n } from '../../../hooks/useI18n';
import { useAppStore } from '../../../stores/appStore';
import { toast } from '../../../hooks/useToast';
import { useSessionStore } from '../../../stores/sessionStore';
import { getDisplaySessionTitle } from '../../../utils/sessionPresentation';
import { CronJobApprovalHint } from './CronJobApprovalHint';
import { Badge } from '../../primitives/Badge';

export function RoleWakeApprovalRuns({ runs, onResolved }: {
  runs: AwaitingApprovalRun[]; onResolved: () => Promise<void>;
}) {
  const { t, language } = useI18n();
  const switchSession = useSessionStore((state) => state.switchSession);
  const setShowCronCenter = useAppStore((state) => state.setShowCronCenter);
  const review = async (sessionId: string) => {
    try {
      await switchSession(sessionId);
      setShowCronCenter(false);
    } catch {
      toast.error(t.cronRunRecord.approvalFailed);
    }
  };
  return runs.filter((run) => run.runKind === 'role_wake').map((run) => (
    <div key={run.runKey} className="mx-6 my-2" data-testid="role-wake-awaiting-approval">
      <div className="flex items-center gap-2 text-sm text-zinc-300">
        <span>{getDisplaySessionTitle(run.title ?? '', language)}</span>
        <Badge className="border-badge-warning/40 text-badge-warning">{t.cronCenter.awaitingApprovalBadge}</Badge>
      </div>
      <CronJobApprovalHint run={run} onResolved={onResolved}
        onReview={() => { if (run.sessionId) void review(run.sessionId); }} />
    </div>
  ));
}
