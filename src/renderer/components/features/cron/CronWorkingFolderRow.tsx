// 定时任务编辑器的「工作文件夹」行（N-FIX-CRON-NO-SOURCE-SESSION-NO-WORKDIR）。
// 面板/API 新建的任务没有来源会话，运行会话无工作目录；这里让用户显式选一个，
// 存进 metadata.workingDirectory。桌面壳用原生选择器（不走 pickWorkingDirectory：
// 它会顺手改聊天的当前工作区），web 构建退回纯路径输入。
import React from 'react';
import { FolderOpen } from 'lucide-react';
import type { CronRunsOn } from '@shared/contract';
import {
  CRON_WORKING_DIRECTORY_METADATA_KEY,
  cronWorkingDirectoryFromMetadata,
} from '@shared/cronWriteScope';
import { FormField } from '../../composites/FormField';
import { Button } from '../../primitives/Button';
import { Input } from '../../primitives/Input';
import { useI18n } from '../../../hooks/useI18n';
import { pickNativeDirectory } from '../../../services/tauriPluginFacade';
import { isTauriMode } from '../../../utils/platform';

/** 路径最后一段，用作展示名（完整路径放 tooltip）。 */
export function cronFolderDisplayName(folder: string): string {
  const trimmed = folder.replace(/[/\\]+$/, '');
  const name = trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
  return name || folder;
}

/** 把选中的文件夹写回 metadata（清除时删键；其余键原样保留）。 */
function withCronWorkingDirectory(
  metadata: Record<string, unknown> | undefined,
  folder: string | undefined,
): Record<string, unknown> | undefined {
  const next = { ...(metadata ?? {}) };
  if (folder) next[CRON_WORKING_DIRECTORY_METADATA_KEY] = folder;
  else delete next[CRON_WORKING_DIRECTORY_METADATA_KEY];
  return Object.keys(next).length > 0 ? next : undefined;
}

interface CronWorkingFolderRowProps {
  runsOn: CronRunsOn;
  metadata: Record<string, unknown> | undefined;
  onMetadataChange: (metadata: Record<string, unknown> | undefined) => void;
}

export const CronWorkingFolderRow: React.FC<CronWorkingFolderRowProps> = ({ runsOn, metadata, onMetadataChange }) => {
  const copy = useI18n().t.cronWorkingFolder;
  if (runsOn !== 'local') return null;

  const folder = cronWorkingDirectoryFromMetadata(metadata);
  const rawFolder = metadata?.[CRON_WORKING_DIRECTORY_METADATA_KEY];
  const setFolder = (next: string | undefined) => onMetadataChange(withCronWorkingDirectory(metadata, next));
  const handlePick = async () => {
    try {
      const picked = await pickNativeDirectory({ title: copy.pickTitle });
      if (picked) setFolder(picked);
    } catch (error) {
      console.warn('[CronWorkingFolderRow] pick folder failed', error);
    }
  };

  return (
    <FormField label={copy.label} hint={copy.hint}>
      {isTauriMode() ? (
        <div className="flex items-center gap-2" data-testid="cron-working-folder-row">
          <FolderOpen className="h-4 w-4 shrink-0 text-zinc-500" />
          <span
            className={`min-w-0 flex-1 truncate text-sm ${folder ? 'text-zinc-200' : 'text-zinc-500'}`}
            title={folder}
            data-testid="cron-working-folder-name"
          >
            {folder ? cronFolderDisplayName(folder) : copy.notSelected}
          </span>
          <Button variant="secondary" size="sm" onClick={handlePick} data-testid="cron-working-folder-pick">
            {folder ? copy.change : copy.pick}
          </Button>
          {folder && (
            <Button variant="ghost" size="sm" onClick={() => setFolder(undefined)} data-testid="cron-working-folder-clear">
              {copy.clear}
            </Button>
          )}
        </div>
      ) : (
        <Input
          data-testid="cron-working-folder-input"
          value={typeof rawFolder === 'string' ? rawFolder : ''}
          // 输入中保留原文（含空格，如「My Notes」）；只在失焦时去首尾空白提交，
          // 空白串等于没选（保存载荷在 buildCronJobInput 里再规整一次）。
          onChange={(event) => setFolder(event.target.value || undefined)}
          onBlur={(event) => setFolder(event.target.value.trim() || undefined)}
          placeholder={copy.pathPlaceholder}
        />
      )}
    </FormField>
  );
};
