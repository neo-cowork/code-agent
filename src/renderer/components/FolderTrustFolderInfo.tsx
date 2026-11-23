import React, { useState } from 'react';
import { useI18n } from '../hooks/useI18n';
import { formatDisplayPath } from '../utils/displayPath';
import { GhostButton } from './primitives/Button';

interface FolderTrustFolderInfoProps {
  displayPath: string;
  canonicalRealpath: string;
  /** 涉及的配置文件相对路径；只在展开详情里出现 */
  files: string[];
  showLabel?: boolean;
}

/**
 * 信任确认里的「文件夹」一行：默认只给一行短路径（不带绝对前缀），
 * 完整路径、真实路径（仅在与显示路径不同时）、具体配置文件都收在同一个详情展开里。
 * 展开内容只在展开时才渲染（不是 CSS 隐藏），DOM 文本与读屏一致。
 */
export const FolderTrustFolderInfo: React.FC<FolderTrustFolderInfoProps> = ({
  displayPath,
  canonicalRealpath,
  files,
  showLabel = false,
}) => {
  const { t } = useI18n();
  const copy = t.folderTrust;
  const [expanded, setExpanded] = useState(false);
  const differs = Boolean(canonicalRealpath) && canonicalRealpath !== displayPath;

  return (
    <div className="space-y-1" data-testid="folder-trust-folder-info">
      {showLabel && <p className="text-zinc-400">{copy.directory}</p>}
      <p className="font-mono text-xs text-zinc-100 break-all">{formatDisplayPath(displayPath)}</p>
      {differs && <p className="text-xs text-zinc-400">{copy.locationDiffers}</p>}
      <GhostButton
        size="sm"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        data-testid="folder-trust-details-toggle"
      >
        {expanded ? copy.hideDetails : copy.showDetails}
      </GhostButton>
      {expanded && (
        <div className="space-y-1 rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-2" data-testid="folder-trust-details">
          <p className="text-zinc-500">{copy.fullPath}</p>
          <p className="font-mono text-xs text-zinc-100 break-all">{displayPath}</p>
          {differs && (
            <>
              <p className="text-zinc-500">{copy.realpath}</p>
              <p className="font-mono text-xs text-zinc-400 break-all">{canonicalRealpath}</p>
            </>
          )}
          {files.length > 0 && (
            <>
              <p className="text-zinc-500">{copy.filesInvolved}</p>
              {files.map((file) => (
                <p key={file} className="font-mono text-xs text-zinc-400 break-all">{file}</p>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
};
