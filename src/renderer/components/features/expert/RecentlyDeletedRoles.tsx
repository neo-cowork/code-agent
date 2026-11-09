import React, { useCallback, useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { ROLE_ASSETS } from '@shared/constants';
import type { TrashedRoleEntry } from '@shared/contract/roleAssets';
import { DomainInvokeError } from '../../../services/ipcService';
import { listDeletedRoles, restoreDeletedRole } from '../../../services/rolesClient';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import { Button } from '../../primitives/Button';

const DAY_MS = 24 * 60 * 60 * 1000;

function daysSinceDeletion(deletedAt: string, now = Date.now()): { daysAgo: number; daysLeft: number } {
  const deletedAtMs = Date.parse(deletedAt);
  if (!Number.isFinite(deletedAtMs)) {
    return { daysAgo: 0, daysLeft: ROLE_ASSETS.TRASH_RETENTION_DAYS };
  }
  const elapsed = Math.max(0, now - deletedAtMs);
  return {
    daysAgo: Math.floor(elapsed / DAY_MS),
    daysLeft: Math.max(0, Math.ceil((ROLE_ASSETS.TRASH_RETENTION_DAYS * DAY_MS - elapsed) / DAY_MS)),
  };
}

export interface RecentlyDeletedRolesProps {
  onRestored?: () => Promise<void> | void;
}

export const RecentlyDeletedRoles: React.FC<RecentlyDeletedRolesProps> = ({ onRestored }) => {
  const { t } = useI18n();
  const text = t.expert.recentlyDeleted;
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<TrashedRoleEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringTrashId, setRestoringTrashId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await listDeletedRoles());
    } catch {
      toast.error(text.failed);
    } finally {
      setLoading(false);
    }
  }, [text.failed]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const restore = async (entry: TrashedRoleEntry) => {
    setRestoringTrashId(entry.trashId);
    try {
      await restoreDeletedRole(entry.trashId);
      setEntries((current) => current.filter((item) => item.trashId !== entry.trashId));
      toast.success(text.restoredToast.replace('{name}', entry.displayName));
      try {
        await onRestored?.();
      } catch {
        // The restored asset is already safe; a parent refresh can retry independently.
      }
    } catch (error) {
      if (error instanceof DomainInvokeError && error.code === 'ROLE_RESTORE_CONFLICT') {
        toast.error(text.conflict);
      } else {
        toast.error(text.failed);
      }
    } finally {
      setRestoringTrashId(null);
    }
  };

  return (
    <section data-testid="recently-deleted-roles" className="relative">
      <Button
        variant="secondary"
        size="sm"
        data-testid="recently-deleted-toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
      >
        {text.title}
      </Button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-2 w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-zinc-800 bg-zinc-900 p-3 shadow-xl" data-testid="recently-deleted-list">
          <h2 className="mb-3 text-sm font-medium text-zinc-200">{text.title}</h2>
          {loading ? <p className="text-xs text-zinc-500">{text.loading}</p> : null}
          {!loading && entries.length === 0 ? <p className="text-xs text-zinc-500">{text.empty}</p> : null}
          {!loading && entries.length > 0 ? (
            <div className="space-y-2">
              {entries.map((entry) => {
                const relative = daysSinceDeletion(entry.deletedAt);
                const restoring = restoringTrashId === entry.trashId;
                return (
                  <div key={entry.trashId} data-testid="recently-deleted-role-row" className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-zinc-100">{entry.displayName}</p>
                      <p className="text-xs text-zinc-500">
                        {text.deletedDays.replace('{days}', String(relative.daysAgo)).replace('{daysLeft}', String(relative.daysLeft))}
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={restoring}
                      disabled={restoring}
                      data-testid="recently-deleted-restore"
                      onClick={() => { void restore(entry); }}
                    >
                      {restoring ? text.restoring : text.restore}
                    </Button>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};
