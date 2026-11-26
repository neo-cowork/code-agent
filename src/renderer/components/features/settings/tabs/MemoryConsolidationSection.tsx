// ============================================================================
// MemoryConsolidationSection —— 「自动整理记忆」开关 + 「最近整理」记录
// 读写 settings.memory.autoConsolidate；host 侧在设置保存时同步 cron job 的 dryRun。
// 独立成组件而非内联进 MemoryTab：后者已逼近 max-lines。
// 最近整理（N-MEM-CONSOLIDATION-HISTORY-UNDO）：列出每次自动整理改了什么，
// 支持把一次整理恢复原样；开关未开启时展示最近一次检查的预告句。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc/domains';
import type { AppSettings } from '@shared/contract';
import type {
  MemoryTidyHistoryResult,
  MemoryTidyRestoreResult,
  MemoryTidyRunView,
} from '@shared/contract/memory';
import { Badge, Button, GhostButton, Toggle } from '../../../primitives';
import { SettingsSection } from '../SettingsLayout';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { formatMemoryEntryUpdatedAt } from './MemoryEntriesManager';
import { localeForLanguage } from '../../../../utils/i18nTime';
import {
  buildTidyPreviewSentence,
  buildTidyRunSummary,
} from './MemoryTidyHistory.helpers';

const MemoryTidyHistory: React.FC<{ toggleEnabled: boolean | null }> = ({ toggleEnabled }) => {
  const { t, language } = useI18n();
  const copy = t.settings.memoryTidy;
  const locale = localeForLanguage(language === 'en' ? 'en' : 'zh');
  const [history, setHistory] = useState<MemoryTidyHistoryResult | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<{ auditId: string; text: string } | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const result = await ipcService.invokeDomain<MemoryTidyHistoryResult>(
        IPC_DOMAINS.MEMORY,
        'memoryTidyList',
      );
      setHistory(result);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const handleRestore = async (run: MemoryTidyRunView) => {
    if (restoringId) return;
    setRestoringId(run.auditId);
    setConfirmingId(null);
    setRestoreError(null);
    try {
      const result = await ipcService.invokeDomain<MemoryTidyRestoreResult>(
        IPC_DOMAINS.MEMORY,
        'memoryTidyRestore',
        { auditId: run.auditId },
      );
      if (result?.ok) {
        await loadHistory();
      } else {
        const code = result?.code && result.code in copy.restoreErrors ? result.code : 'restore-failed';
        setRestoreError({ auditId: run.auditId, text: copy.restoreErrors[code] });
      }
    } catch {
      setRestoreError({ auditId: run.auditId, text: copy.restoreErrors['restore-failed'] });
    } finally {
      setRestoringId(null);
    }
  };

  const runs = history?.runs ?? [];

  return (
    <div
      data-testid="memory-tidy-history"
      className="mt-3 rounded-lg border border-zinc-700/70 bg-zinc-900/60 px-3 py-3"
    >
      <div className="text-sm font-medium text-zinc-200">{copy.recentTitle}</div>
      <p className="mt-1 text-xs text-zinc-500">{copy.recentDescription}</p>

      {toggleEnabled === false && (
        <p data-testid="memory-tidy-preview" className="mt-2 text-xs text-zinc-400">
          {buildTidyPreviewSentence(
            history?.preview ?? null,
            copy,
            t.settings.memory.relativeDate,
            locale,
          )}
        </p>
      )}

      {loadFailed && <p className="mt-2 text-xs text-badge-warning">{copy.loadFailed}</p>}

      {!loadFailed && runs.length === 0 && (
        <p className="mt-2 text-xs text-zinc-500">{copy.empty}</p>
      )}

      <div className="mt-2 space-y-2">
        {runs.map((run) => {
          const expanded = expandedId === run.auditId;
          const error = restoreError?.auditId === run.auditId ? restoreError.text : null;
          return (
            <div
              key={run.auditId}
              data-testid="memory-tidy-run"
              className="rounded-md border border-zinc-800 bg-zinc-900/80 px-3 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 pt-1 text-xs text-zinc-300">
                  <span className="block truncate">
                    {formatMemoryEntryUpdatedAt(
                      run.at,
                      Date.now(),
                      t.settings.memory.relativeDate,
                      locale,
                    )}
                    {' · '}
                    {buildTidyRunSummary(run, copy)}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {run.restored ? (
                    <Badge data-testid="memory-tidy-restored">{copy.restoredBadge}</Badge>
                  ) : null}
                  <GhostButton
                    size="sm"
                    aria-expanded={expanded}
                    aria-label={expanded ? copy.collapseLabel : copy.expandLabel}
                    onClick={() => setExpandedId(expanded ? null : run.auditId)}
                    leftIcon={expanded
                      ? <ChevronDown className="h-3.5 w-3.5" />
                      : <ChevronRight className="h-3.5 w-3.5" />}
                    data-testid="memory-tidy-expand"
                  />
                </div>
              </div>

              {expanded && (
                <div className="mt-2 space-y-1.5 border-t border-zinc-800 pt-2 text-xs text-zinc-400">
                  {run.merges.map((merge) => (
                    <div key={merge.result.filename} data-testid="memory-tidy-merge">
                      {copy.mergeLineSources
                        .replace('{sources}', merge.sources.map((source) => source.name).join(' + '))
                        .replace('{result}', merge.result.name)}
                      {merge.result.summary && merge.result.summary !== merge.result.name
                        ? copy.resultSummaryParens.replace('{summary}', merge.result.summary)
                        : ''}
                    </div>
                  ))}
                  {(() => {
                    const putAway = run.merges.flatMap((merge) => merge.sources);
                    if (putAway.length === 0) return null;
                    return (
                      <div data-testid="memory-tidy-putaway">
                        {copy.putAwayLabel.replace(
                          '{names}',
                          putAway.map((source) => source.name).join(t.punctuation.listSeparator),
                        )}
                      </div>
                    );
                  })()}
                  {run.conflicts.map((conflict) => (
                    <div key={conflict.source.filename} data-testid="memory-tidy-conflict">
                      {copy.conflictLine
                        .replace('{name}', conflict.source.name)
                        .replace('{reason}', conflict.reason)}
                      {!conflict.restorable ? copy.conflictReadOnlyNote : ''}
                    </div>
                  ))}

                  {run.restorable && !run.restored && (
                    <div className="pt-1">
                      {confirmingId === run.auditId ? (
                        <div className="space-y-1.5" data-testid="memory-tidy-confirm">
                          <p className="text-zinc-300">
                            {copy.restoreConfirmTitle}
                            <span className="text-zinc-500">{copy.restoreConfirmBody}</span>
                          </p>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="primary"
                              loading={restoringId === run.auditId}
                              disabled={restoringId !== null}
                              leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                              onClick={() => void handleRestore(run)}
                              data-testid="memory-tidy-confirm-ok"
                            >
                              {copy.restoreConfirmOk}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={restoringId !== null}
                              onClick={() => setConfirmingId(null)}
                              data-testid="memory-tidy-confirm-cancel"
                            >
                              {copy.restoreConfirmCancel}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={restoringId !== null}
                          leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                          onClick={() => {
                            setRestoreError(null);
                            setConfirmingId(run.auditId);
                          }}
                          data-testid="memory-tidy-restore"
                        >
                          {copy.restoreButton}
                        </Button>
                      )}
                    </div>
                  )}
                  {restoringId === run.auditId && (
                    <p className="text-zinc-500">{copy.restoring}</p>
                  )}
                  {error && <p className="text-xs text-badge-danger" data-testid="memory-tidy-error">{error}</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const MemoryConsolidationSection: React.FC = () => {
  const { t } = useI18n();
  const copy = t.settings.memory.consolidation;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    ipcService.invokeDomain<AppSettings>(IPC_DOMAINS.SETTINGS, 'get')
      .then((settings) => {
        if (!cancelled) setEnabled(settings?.memory?.autoConsolidate === true);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => { cancelled = true; };
  }, []);

  const handleToggle = async (next: boolean) => {
    if (saving) return;
    setError(null);
    setSaving(true);
    const previous = enabled;
    setEnabled(next);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.SETTINGS, 'set', {
        memory: { autoConsolidate: next },
      });
    } catch {
      setEnabled(previous);
      setError(copy.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title={copy.title} description={copy.description}>
      <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-zinc-200">{copy.toggleLabel}</span>
          <Toggle
            checked={enabled === true}
            onChange={handleToggle}
            disabled={enabled === null || saving}
            aria-label={copy.toggleLabel}
          />
        </div>
        <p className="mt-2 text-xs text-zinc-500" data-testid="memory-consolidation-hint">
          {enabled === true ? copy.toggleOnHint : copy.toggleOffHint}
        </p>
        {error && <p className="mt-1 text-xs text-badge-warning">{error}</p>}
      </div>
      <MemoryTidyHistory toggleEnabled={enabled} />
    </SettingsSection>
  );
};
