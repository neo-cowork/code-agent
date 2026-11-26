// 当前工作目录已经不在磁盘上时，在 cwd 旁边给出警告和重新选择。
// 缺失警告和按钮文案复用聊天卡片，选择目录的提示由工作区设置提供。

import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { WorkspaceDirectorySummary } from '@shared/contract';
import { Button } from '../../../primitives';
import { useI18n } from '../../../../hooks/useI18n';
import ipcService from '../../../../services/ipcService';
import { isWebMode } from '../../../../utils/platform';

function directoryBasename(dir: string): string {
  const parts = dir.trim().replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  const name = parts[parts.length - 1] ?? '';
  if (!name || name === '.' || name === '..') return '';
  return name;
}

export function MissingWorkspaceDirectoryNotice({
  dir,
  pickFeedback,
  onReselect,
}: {
  dir: string;
  pickFeedback: 'nothingChosen' | 'failed' | null;
  onReselect: () => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [exists, setExists] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    setExists(null);
    void ipcService.invokeDomain<WorkspaceDirectorySummary | null>(
      IPC_DOMAINS.WORKSPACE,
      'getDirectorySummary',
      { dir },
    ).then((summary) => {
      if (cancelled) return;
      setExists(summary && typeof summary.exists === 'boolean' ? summary.exists : null);
    }).catch(() => {
      if (!cancelled) setExists(null);
    });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  if (exists !== false) return null;

  const copy = t.turnCard.projectTrustConfirm;
  const { reselectWebHint, pickDirectoryNothingChosen, pickDirectoryFailed } = t.settings.workspace.actions;
  const webMode = isWebMode();
  const name = directoryBasename(dir) || copy.folder;
  const warning = copy.reasons.source_missing.replace('{name}', name);

  return (
    <div
      data-testid="workspace-directory-missing"
      className="border-t border-zinc-700/60 px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-mark-warning">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{warning}</span>
        </span>
        <Button size="sm" variant="secondary" disabled={webMode} onClick={onReselect}>
          {copy.reselect}
        </Button>
        {webMode && <span className="text-zinc-300">{reselectWebHint}</span>}
      </div>
      {!webMode && (
        <div role="status">
          {pickFeedback === 'nothingChosen' && <p className="mt-1 text-zinc-300">{pickDirectoryNothingChosen}</p>}
          {pickFeedback === 'failed' && <p className="mt-1 text-mark-warning">{pickDirectoryFailed}</p>}
        </div>
      )}
    </div>
  );
}
