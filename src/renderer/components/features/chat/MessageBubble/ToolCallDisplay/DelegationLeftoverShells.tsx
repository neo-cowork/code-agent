import React, { useEffect, useMemo, useState } from 'react';
import { resolveBackgroundTaskTitle } from '@shared/backgroundTaskTitle';
import type { Task } from '@shared/contract/backgroundTask';
import { getSystemPromptHint, type SessionTaskSlotLocale } from '@shared/i18n/sessionTaskSlot';
import { useI18n } from '../../../../../hooks/useI18n';
import type { Translations } from '../../../../../i18n';
import { useBackgroundTaskStore } from '../../../../../stores/backgroundTaskStore';
import { stopSessionAgent } from '../../../../../utils/stopSessionAgent';
import { Button } from '../../../../primitives/Button';
import type { DelegationPresentation } from './delegationPresentation';

type LeftoverShellCopy = Translations['chat']['delegationReceipt']['leftoverShells'];

interface StoppedShellSnapshot {
  id: string;
  source: Task['source'];
  title: string;
  mayAwaitSystemPrompt: boolean;
}

function resolveShellLedgerKey(task: Task): string {
  if (task.id.startsWith('shell:')) return task.id;
  const originalTaskId = task.metadata?.originalTaskId;
  if (typeof originalTaskId === 'string' && originalTaskId) {
    return `shell:${originalTaskId}`;
  }
  return task.id;
}

function formatElapsed(task: Task, now: number, copy: LeftoverShellCopy): string {
  const startedAt = task.startedAt ?? task.createdAt;
  const elapsedMs = startedAt > 0 && now >= startedAt
    ? now - startedAt
    : Math.max(0, task.durationMs ?? 0);
  const seconds = Math.max(1, Math.round(elapsedMs / 1_000));
  if (seconds < 60) return copy.runningSeconds.replace('{count}', String(seconds));
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return copy.runningMinutes.replace('{count}', String(minutes));
  const hours = Math.round(minutes / 60);
  return copy.runningHours.replace('{count}', String(hours));
}

export function DelegationLeftoverShells({ presentation }: { presentation: DelegationPresentation }) {
  const { t, language } = useI18n();
  const locale: SessionTaskSlotLocale = language === 'en' ? 'en' : 'zh';
  const copy = t.chat.delegationReceipt.leftoverShells;
  const tasks = useBackgroundTaskStore((state) => state.tasks);
  const [stoppingIds, setStoppingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [stoppedSnapshots, setStoppedSnapshots] = useState<Readonly<Record<string, StoppedShellSnapshot>>>({});
  const [now, setNow] = useState(() => Date.now());

  const ownerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of presentation.activityIds) {
      if (id) ids.add(id);
    }
    if (presentation.memberId) ids.add(presentation.memberId);
    return ids;
  }, [presentation.activityIds, presentation.memberId]);

  const runningTasks = useMemo(() => {
    if (ownerIds.size === 0) return [];
    return tasks.filter((task) => (
      task.kind === 'shell'
      && task.status === 'running'
      && !stoppedSnapshots[task.id]
      && typeof task.metadata?.ownerAgentId === 'string'
      && ownerIds.has(task.metadata.ownerAgentId)
    ));
  }, [ownerIds, stoppedSnapshots, tasks]);

  const stoppedRows = useMemo(() => {
    const ownedById = new Map(
      tasks
        .filter((task) => (
          task.kind === 'shell'
          && typeof task.metadata?.ownerAgentId === 'string'
          && ownerIds.has(task.metadata.ownerAgentId)
        ))
        .map((task) => [task.id, task] as const),
    );
    return Object.values(stoppedSnapshots).map((snapshot) => {
      const live = ownedById.get(snapshot.id);
      return live
        ? {
            id: live.id,
            source: live.source,
            title: live.title,
            mayAwaitSystemPrompt: live.metadata?.mayAwaitSystemPrompt === true || snapshot.mayAwaitSystemPrompt,
          }
        : snapshot;
    });
  }, [ownerIds, stoppedSnapshots, tasks]);

  useEffect(() => {
    if (runningTasks.length === 0) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [runningTasks.length]);

  if (runningTasks.length === 0 && stoppedRows.length === 0) return null;

  const handleStop = async (task: Task): Promise<void> => {
    if (stoppingIds.has(task.id)) return;
    setStoppingIds((prev) => new Set(prev).add(task.id));
    setFailedIds((prev) => {
      if (!prev.has(task.id)) return prev;
      const next = new Set(prev);
      next.delete(task.id);
      return next;
    });
    try {
      const ledgerKey = resolveShellLedgerKey(task);
      const result = await stopSessionAgent(
        { kind: 'task', key: ledgerKey },
        presentation.sessionId ?? null,
      );
      if (result === 'stopped') {
        setStoppedSnapshots((prev) => ({
          ...prev,
          [task.id]: {
            id: task.id,
            source: task.source,
            title: task.title,
            mayAwaitSystemPrompt: task.metadata?.mayAwaitSystemPrompt === true,
          },
        }));
      }
      const refreshTasks = useBackgroundTaskStore.getState?.()?.refreshTasks;
      if (typeof refreshTasks === 'function') {
        await refreshTasks().catch(() => undefined);
      }
      if (result !== 'stopped') {
        const latestTasks = useBackgroundTaskStore.getState?.()?.tasks;
        const latest = Array.isArray(latestTasks)
          ? latestTasks.find((candidate) => candidate.id === task.id)
          : undefined;
        if (!latest || latest.status === 'running') {
          setFailedIds((prev) => new Set(prev).add(task.id));
        }
      }
    } finally {
      setStoppingIds((prev) => {
        if (!prev.has(task.id)) return prev;
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
  };

  return (
    <div className="space-y-1 pt-0.5" data-testid="delegation-leftover-shells">
      {runningTasks.map((task) => {
        const title = resolveBackgroundTaskTitle(task, locale, t.agentRoleLabels.backgroundCommand);
        const isStopping = stoppingIds.has(task.id);
        const hasError = failedIds.has(task.id);
        const mayAwaitSystemPrompt = task.metadata?.mayAwaitSystemPrompt === true;
        return (
          <div
            key={task.id}
            className="space-y-0.5"
            data-testid="delegation-leftover-shell-row"
            data-task-id={task.id}
            data-status="running"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="min-w-0 break-words text-zinc-300">
                {copy.stillRunning.replace('{title}', title)}
              </span>
              <span className="text-zinc-500">· {formatElapsed(task, now, copy)}</span>
              <Button
                variant="ghost"
                size="sm"
                loading={isStopping}
                data-testid="delegation-leftover-shell-stop"
                onClick={() => { void handleStop(task); }}
              >
                {isStopping ? copy.stopping : copy.stop}
              </Button>
            </div>
            {hasError && (
              <div className="text-badge-danger" data-testid="delegation-leftover-shell-error">
                {copy.stopFailed}
              </div>
            )}
            {mayAwaitSystemPrompt && (
              <div className="text-zinc-400" data-testid="delegation-leftover-shell-prompt-hint">
                {getSystemPromptHint(locale)}
              </div>
            )}
          </div>
        );
      })}
      {stoppedRows.map((row) => {
        const title = resolveBackgroundTaskTitle(row, locale, t.agentRoleLabels.backgroundCommand);
        return (
          <div
            key={row.id}
            className="space-y-0.5"
            data-testid="delegation-leftover-shell-row"
            data-task-id={row.id}
            data-status="stopped"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="min-w-0 break-words text-zinc-400">{title}</span>
              <span className="text-zinc-500" data-testid="delegation-leftover-shell-stopped">
                · {copy.stopped}
              </span>
            </div>
            {row.mayAwaitSystemPrompt && (
              <div className="text-zinc-400" data-testid="delegation-leftover-shell-prompt-hint">
                {getSystemPromptHint(locale)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
