// ============================================================================
// ExternalImportMcpSection - MCP 服务器导入的预览/结果卡（N-EXTHISTORY-IMPORT-K1B-MCP）
// ============================================================================
//
// 预览卡：来源文件状态（坏文件给文件级原因）+ 条目行（名称、来源应用、命令摘要、
// 跳过项灰显带原因标签）。结果卡：状态行（已导入（未启用）/已跳过/需要先补 KEY）
// + 每个已导入 server 一个启用开关——启用前必须过确认对话框，对话框先给完整
// 命令行/地址。禁用不需要确认。启用/禁用复用 MCP 设置页同一 setServerEnabled。

import React, { useState } from 'react';
import { Loader2, Server } from 'lucide-react';
import type {
  ExternalMcpApplyResult,
  ExternalMcpApplyResultItem,
  ExternalMcpPreviewResult,
  ExternalMcpPlanItem,
} from '@shared/contract/externalImport';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { Toggle } from '../../../primitives';
import { ConfirmDialog } from '../../../composites/ConfirmDialog';

export type ExternalImportMcpCopy = ReturnType<typeof useI18n>['t']['settings']['externalImportMcp'];

/** 来源显示名（K1A externalImport 组的 sourceNames，键与 MCP 来源一致）。 */
export type ExternalImportSourceNames = Record<string, string>;

function ItemLine({
  item,
  copy,
  sourceNames,
  muted,
  trailing,
}: {
  item: ExternalMcpPlanItem | ExternalMcpApplyResultItem;
  copy: ExternalImportMcpCopy;
  sourceNames: ExternalImportSourceNames;
  muted?: boolean;
  trailing?: React.ReactNode;
}) {
  const reason = 'reason' in item && item.reason ? copy.reasonLabels[item.reason] : null;
  return (
    <div
      className={`flex items-center gap-3 border-b border-zinc-800 px-3 py-2 last:border-b-0 ${muted ? 'opacity-60' : ''}`}
      data-testid={`external-import-mcp-item-${item.sourceId}-${item.name}`}
    >
      <Server className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-zinc-200">
          {item.name}
          <span className="mx-1.5 text-zinc-500">·</span>
          <span className="text-zinc-400">{sourceNames[item.sourceId] ?? item.sourceId}</span>
          <span className="mx-1.5 text-zinc-500">·</span>
          <span className="text-zinc-500">{copy.kindLabels[item.kind]}</span>
        </div>
        {item.commandSummary && (
          <div className="truncate font-mono text-[11px] text-zinc-500">{item.commandSummary}</div>
        )}
        {reason && <div className="truncate text-[11px] text-zinc-500">{reason}</div>}
        {item.neededEnvKeys.length > 0 && (
          <div className="truncate text-[11px] text-badge-warning">
            {copy.neededKeysLine.replace('{keys}', item.neededEnvKeys.join(', '))}
          </div>
        )}
        {'error' in item && item.error && (
          <div className="truncate font-mono text-[11px] text-zinc-600">{item.error}</div>
        )}
      </div>
      {trailing}
    </div>
  );
}

/** 预览卡：文件状态 + 条目计划（重复/跳过灰显）。纯展示。 */
export function ExternalImportMcpPreview({
  copy,
  sourceNames,
  preview,
}: {
  copy: ExternalImportMcpCopy;
  sourceNames: ExternalImportSourceNames;
  preview: ExternalMcpPreviewResult;
}) {
  const importCount = preview.summary.import;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3" data-testid="external-import-preview-mcp">
      <div className="text-xs font-medium text-zinc-400">
        {copy.previewTitle.replace('{count}', String(importCount))}
      </div>
      <div className="mt-2 space-y-1 text-[11px] text-zinc-500">
        {preview.files
          .filter((file) => file.status !== 'ok')
          .map((file) => (
            <div key={file.sourceId} className="truncate" data-testid={`external-import-mcp-file-${file.sourceId}`}>
              {sourceNames[file.sourceId] ?? file.sourceId}
              {' · '}
              {copy.fileStatusLabels[file.status]}
              {file.error ? copy.fileErrorSuffix.replace('{error}', file.error) : ''}
            </div>
          ))}
      </div>
      {preview.items.length > 0 ? (
        <div className="mt-2 overflow-hidden rounded-lg border border-zinc-800">
          {preview.items.map((item) => (
            <ItemLine
              key={`${item.sourceId}:${item.name}`}
              item={item}
              copy={copy}
              sourceNames={sourceNames}
              muted={item.disposition === 'skip'}
            />
          ))}
        </div>
      ) : (
        <div className="mt-2 text-[11px] text-zinc-500">{copy.noImportable}</div>
      )}
    </div>
  );
}

/** 结果卡：状态行 + 每个已导入 server 的启用开关（启用前先确认完整命令）。 */
export function ExternalImportMcpResults({
  copy,
  sourceNames,
  result,
}: {
  copy: ExternalImportMcpCopy;
  sourceNames: ExternalImportSourceNames;
  result: ExternalMcpApplyResult;
}) {
  const [enabledNames, setEnabledNames] = useState<Set<string>>(new Set());
  const [pendingEnable, setPendingEnable] = useState<ExternalMcpApplyResultItem | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setEnabled = async (name: string, enabled: boolean): Promise<void> => {
    setBusyName(name);
    setError(null);
    try {
      await ipcService.invokeDomain(IPC_DOMAINS.MCP, 'setServerEnabled', { serverName: name, enabled });
      setEnabledNames((current) => {
        const next = new Set(current);
        if (enabled) next.add(name);
        else next.delete(name);
        return next;
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.enableFailed);
    } finally {
      setBusyName(null);
    }
  };

  const importedItems = result.items.filter((item) => item.action === 'imported');
  const skippedItems = result.items.filter((item) => item.action === 'skipped');

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3" data-testid="external-import-results-mcp">
      <div className="text-xs text-zinc-300">
        {copy.resultsTitle
          .replace('{imported}', String(result.imported))
          .replace('{skipped}', String(result.skipped))}
      </div>
      {error && <div className="mt-2 shrink-0 rounded bg-red-500/10 px-2 py-1 text-[11px] text-badge-danger">{error}</div>}
      <div className="mt-2 overflow-hidden rounded-lg border border-zinc-800">
        {importedItems.map((item) => (
          <ItemLine
            key={`${item.sourceId}:${item.name}`}
            item={item}
            copy={copy}
            sourceNames={sourceNames}
            trailing={
              <div className="flex shrink-0 items-center gap-1.5">
                {busyName === item.name && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />}
                <span className="text-[11px] text-zinc-500">
                  {enabledNames.has(item.name) ? copy.enabledLabel : copy.importedLabel}
                </span>
                <Toggle
                  checked={enabledNames.has(item.name)}
                  disabled={busyName === item.name}
                  onChange={(checked) => {
                    if (checked) setPendingEnable(item);
                    else void setEnabled(item.name, false);
                  }}
                  aria-label={copy.enableToggleLabel}
                />
              </div>
            }
          />
        ))}
        {skippedItems.map((item) => (
          <ItemLine
            key={`${item.sourceId}:${item.name}`}
            item={item}
            copy={copy}
            sourceNames={sourceNames}
            muted
          />
        ))}
      </div>

      <ConfirmDialog
        isOpen={pendingEnable !== null}
        title={copy.enableDialogTitle}
        message={
          <div data-testid="external-import-mcp-enable-content">
            <div className="text-xs text-zinc-300">
              {pendingEnable?.kind === 'remote' ? copy.enableDialogRemoteLead : copy.enableDialogLead}
            </div>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950/70 p-2 font-mono text-xs text-zinc-200">
              {pendingEnable?.commandSummary ?? ''}
            </pre>
            <div className="mt-2 text-[11px] text-zinc-500">{copy.enableDialogHint}</div>
          </div>
        }
        confirmText={copy.enableDialogConfirm}
        cancelText={copy.enableDialogCancel}
        onConfirm={() => {
          const item = pendingEnable;
          setPendingEnable(null);
          if (item) void setEnabled(item.name, true);
        }}
        onCancel={() => setPendingEnable(null)}
      />
    </div>
  );
}
