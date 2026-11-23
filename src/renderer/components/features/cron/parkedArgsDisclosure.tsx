import React from 'react';
import { approvalPreviewBasename } from '../../../utils/approvalPreviewBasename';

const FILE_PREVIEW_TOOLS = new Set(['write', 'edit', 'append']);

export function folderDisplayName(folder: string): string {
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? folder;
}

function isShellTool(tool: string): boolean {
  return tool.toLowerCase() === 'bash';
}

function isFilePreviewTool(tool: string): boolean {
  return FILE_PREVIEW_TOOLS.has(tool.toLowerCase());
}

/** Visible file name. Basename first; the folder splitter covers previews it declines. */
function filePreviewName(preview: string): string {
  return approvalPreviewBasename(preview) ?? folderDisplayName(preview);
}

export function ParkedArgsDisclosure({
  tool,
  argsPreview,
  groupPaths,
  previewLabel,
  groupSeparator,
  showCommand,
  showLocation,
}: {
  tool: string;
  argsPreview?: string;
  groupPaths?: string[];
  previewLabel: string;
  groupSeparator: string;
  showCommand: string;
  showLocation: string;
}): React.ReactElement | null {
  if (!argsPreview) return null;
  if (isShellTool(tool)) {
    return (
      <details className="text-[11px] text-zinc-400">
        <summary className="cursor-pointer">{showCommand}</summary>
        <div className="whitespace-pre-wrap break-words" data-testid="parked-shell-preview">{argsPreview}</div>
      </details>
    );
  }
  const multiPaths = groupPaths && groupPaths.length > 1 ? groupPaths : undefined;
  const fileTool = isFilePreviewTool(tool);
  const visible = multiPaths
    ? multiPaths.map((path) => folderDisplayName(path)).join(groupSeparator)
    : fileTool ? filePreviewName(argsPreview) : argsPreview;
  // A single file's absolute path lives in the location disclosure. A multi-file
  // group has no separate disclosure, so the existing hover title keeps every path.
  const title = multiPaths ? multiPaths.join('\n') : fileTool ? undefined : argsPreview;
  return (
    <>
      <div
        className="whitespace-pre-wrap break-words text-[11px] text-zinc-400"
        data-testid="parked-args-preview"
        title={title}
      >
        {previewLabel}{visible}
      </div>
      {fileTool && !multiPaths && (
        <details className="text-[11px] text-zinc-400">
          <summary className="cursor-pointer">{showLocation}</summary>
          <div className="whitespace-pre-wrap break-words" data-testid="parked-file-location">{argsPreview}</div>
        </details>
      )}
    </>
  );
}
