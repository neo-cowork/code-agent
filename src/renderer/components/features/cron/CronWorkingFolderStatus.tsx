// 任务卡 / 任务详情 / 运行详情的「工作文件夹」状态行（N-FIX-CRON-NO-SOURCE-SESSION-NO-WORKDIR）。
// 任务侧一律走 shared cronWriteScopeFolder（与 host 建会话、写授权候选同一个解析，
// 不另写第二份）；运行侧直接读该次运行会话实际落到的目录。
import React from 'react';
import { FolderOpen } from 'lucide-react';
import type { CronJobDefinition } from '@shared/contract';
import { cronSourceSessionIdFromDefinition, cronWriteScopeFolder } from '@shared/cronWriteScope';
import { useI18n } from '../../../hooks/useI18n';
import { useSessionStore } from '../../../stores/sessionStore';
import { cronFolderDisplayName } from './CronWorkingFolderRow';

const FolderLine: React.FC<{ folder: string | undefined; showHint?: boolean; testId: string }> = ({ folder, showHint, testId }) => {
  const copy = useI18n().t.cronWorkingFolder;
  return (
    <div
      className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-zinc-500"
      data-testid={testId}
      title={folder ?? (showHint ? copy.detailMissingHint : undefined)}
    >
      <FolderOpen className="h-3 w-3 shrink-0" />
      <span className="truncate">
        {folder
          ? `${copy.detailLabel}：${cronFolderDisplayName(folder)}`
          : copy.detailMissing}
      </span>
      {!folder && showHint && <span className="truncate text-zinc-600">{copy.detailMissingHint}</span>}
    </div>
  );
};

/** 本地 agent 任务的工作文件夹（任务卡、任务详情）；其余任务不渲染。 */
export const CronJobWorkingFolderStatus: React.FC<{ job: CronJobDefinition; showHint?: boolean }> = ({ job, showHint }) => {
  const sourceSessionId = cronSourceSessionIdFromDefinition(job);
  const sourceFolder = useSessionStore((state) => (
    sourceSessionId ? state.sessions.find((session) => session.id === sourceSessionId)?.workingDirectory : undefined
  ));
  if (job.runsOn !== 'local' || job.action.type !== 'agent') return null;
  return (
    <FolderLine
      folder={cronWriteScopeFolder(job, sourceFolder ?? undefined)}
      showHint={showHint}
      testId="cron-job-working-folder"
    />
  );
};

/** 某次运行会话实际用的工作文件夹（运行详情）。 */
export const CronRunWorkingFolderStatus: React.FC<{ sessionId?: string; runsOn: CronJobDefinition['runsOn'] }> = ({ sessionId, runsOn }) => {
  const session = useSessionStore((state) => (
    sessionId ? state.sessions.find((item) => item.id === sessionId) : undefined
  ));
  if (runsOn !== 'local' || !session) return null;
  return <FolderLine folder={session.workingDirectory || undefined} showHint testId="cron-run-working-folder" />;
};
