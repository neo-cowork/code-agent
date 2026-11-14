import React, { useRef, useState } from 'react';
import type { ParkedApprovalInboxItem } from '@shared/contract/pendingApproval';
import { IPC_CHANNELS } from '@shared/ipc';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import ipcService from '../../../services/ipcService';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { refreshParkedApprovals, useParkedApprovals } from '../../../stores/parkedApprovalStore';
import { claimApprovalResponse, releaseApprovalResponse } from '../../../utils/approvalResponseGuard';
import { humanizeToolStep } from '../../../utils/humanizeToolStep';
import { classifyPermissionDelivery } from '../../PermissionDialog/permissionDelivery';
import { SensitiveStepParkedRow } from '../../PermissionDialog/SensitiveStepHandbackCard';
import { Button } from '../../primitives';

function ParkedApprovalCard({ item }: { item: ParkedApprovalInboxItem }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const responding = useRef(false);
  const copy = t.cronCenter;
  const respond = async (response: 'allow' | 'deny') => {
    if (responding.current || !claimApprovalResponse(item.id)) return;
    responding.current = true;
    setBusy(true);
    try {
      const result = await ipcService.invoke(
        IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, item.id, response, item.sessionId ?? undefined,
      );
      const delivery = classifyPermissionDelivery(result);
      if (delivery === 'stale') toast.info(copy.parkedResolveStale);
      if (delivery === 'retryable') toast.error(copy.parkedResolveFailed);
    } catch {
      toast.error(copy.parkedResolveFailed);
    } finally {
      try {
        await refreshParkedApprovals();
        // Re-read the host projection; never clear durableWaitingInput locally or resume the run.
        const sessionStore = useSessionStore.getState();
        await sessionStore.loadSessions({ silent: true });
        if (useSessionStore.getState().currentSessionId === item.sessionId && item.sessionId) {
          await useSessionStore.getState().switchSession(item.sessionId, { force: true });
        }
      } catch {
        toast.error(copy.parkedResolveFailed);
      }
      responding.current = false;
      releaseApprovalResponse(item.id);
      setBusy(false);
    }
  };
  return (
    <section
      aria-label={t.decisionCard.permission.genericApprovalTitle}
      data-testid="parked-approval-card"
      className="mx-auto mb-2 w-full max-w-3xl rounded-lg border border-badge-warning/60 bg-surface-primary p-3 text-sm"
    >
      <div className="mb-2 font-medium text-zinc-200">
        {humanizeToolStep(item.tool, undefined, t, undefined, 'pending-approval')}
      </div>
      {item.argsPreview && (
        <p className="mb-2 whitespace-pre-wrap break-words text-xs text-zinc-400">{item.argsPreview}</p>
      )}
      {item.commandPreview && item.commandPreview !== item.argsPreview && (
        <details className="mb-2 text-xs text-zinc-400">
          <summary>{t.decisionCard.permission.detailCommand}</summary>
          <pre className="whitespace-pre-wrap break-words">{item.commandPreview}</pre>
        </details>
      )}
      {item.sensitiveStep ? (
        <SensitiveStepParkedRow step={item.sensitiveStep} disabled={busy} onRespond={(response) => void respond(response)} />
      ) : (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void respond('deny')}>
            {t.decisionCard.permission.optionDeny}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void respond('allow')}>
            {t.decisionCard.permission.optionOnce}
          </Button>
        </div>
      )}
    </section>
  );
}

/** Ledger decisions survive process restarts, independently of in-memory permission requests. */
export function ParkedApprovalCards() {
  const sessionId = useSessionStore((state) => state.currentSessionId);
  const items = useParkedApprovals(sessionId);
  const pending = useAppStore((state) => state.pendingPermissionRequest);
  const queued = useAppStore((state) => state.queuedPermissionRequests);
  const liveIds = new Set([
    ...(pending && !pending.resolved ? [pending.id] : []),
    ...Object.values(queued ?? {}).flat().filter((request) => !request.resolved).map((request) => request.id),
  ]);
  const visible = items.filter((item) => item.sessionId === sessionId && item.status === 'pending'
    && item.kind === 'tool_approval' && item.tool.trim() && !liveIds.has(item.id));
  if (!sessionId || visible.length === 0) return null;
  return (
    <div className="w-full shrink-0 chat-col-pad" data-testid="parked-approval-cards">
      {visible.map((item) => <ParkedApprovalCard key={item.id} item={item} />)}
    </div>
  );
}
