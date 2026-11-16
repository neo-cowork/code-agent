import React, { useState } from 'react';
import { AppWindow, ChevronDown, ChevronRight, Loader2, RefreshCw, SquareMousePointer } from 'lucide-react';
import type {
  ComputerSurfaceElementsResult,
  ComputerSurfaceState,
  NativeDesktopCapabilities,
  NativeDesktopCollectorStatus,
} from '../../../services/nativeDesktop';
import type { ComputerUseTarget } from '../../../utils/computerUseWorkbench';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { interpolate } from '../../../i18n/interpolate';

export type StatusTone = 'ready' | 'blocked' | 'warning' | 'neutral';

export interface ElementCandidate {
  id: string;
  role: string;
  label: string;
  axPath: string | null;
  enabled: boolean | null;
}

export function statusToneClass(tone: StatusTone): string {
  switch (tone) {
    case 'ready':
      return 'border-badge-success/30 bg-emerald-500/10 text-badge-success';
    case 'blocked':
      return 'border-badge-danger/30 bg-badge-danger text-badge-danger';
    case 'warning':
      return 'border-badge-warning/30 bg-badge-warning text-badge-warning';
    default:
      return 'border-zinc-700/60 bg-zinc-800/70 text-zinc-400';
  }
}

export const StatusPill: React.FC<{ label: string; tone: StatusTone }> = ({ label, tone }) => (
  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${statusToneClass(tone)}`}>
    {label}
  </span>
);

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

export function toElementCandidates(
  result: ComputerSurfaceElementsResult | null,
  unnamedLabel: string,
): ElementCandidate[] {
  const metadata = result?.metadata;
  const raw = metadata?.elements || metadata?.candidates;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.slice(0, 16).map((item, index) => {
    const record = item && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown>
      : {};
    const role = firstString(record, ['role', 'subrole', 'type']) || 'AXElement';
    const label =
      firstString(record, ['name', 'title', 'label', 'description', 'text', 'value'])
      || firstString(record, ['selector'])
      || unnamedLabel;
    const axPath = firstString(record, ['axPath', 'path']);
    const enabled = typeof record.enabled === 'boolean' ? record.enabled : null;
    const indexValue = typeof record.index === 'number' ? record.index : index + 1;
    return {
      id: `${axPath || role}-${indexValue}`,
      role,
      label,
      axPath,
      enabled,
    };
  });
}

function formatTime(value?: number | null): string {
  if (!value || !Number.isFinite(value)) return '—';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface AxQuality {
  grade?: string;
  reasons?: string[];
}

export interface ComputerUseDiagnosticsProps {
  nativeAvailable: boolean;
  capabilities: NativeDesktopCapabilities | null;
  surface: ComputerSurfaceState | null;
  collectorStatus: NativeDesktopCollectorStatus | null;
  desktopProviderError: string | null;
  observeError: string | null;
  targets: ComputerUseTarget[];
  selectedTargetApp: string | null;
  onSelectTarget: (appName: string) => void;
  elementCandidates: ElementCandidate[];
  elementCount: number;
  elementsLoading: boolean;
  elementsError: string | null;
  axQuality: AxQuality | null;
  onReloadElements: () => void;
}

export const ComputerUseDiagnostics: React.FC<ComputerUseDiagnosticsProps> = ({
  nativeAvailable,
  capabilities,
  surface,
  collectorStatus,
  desktopProviderError,
  observeError,
  targets,
  selectedTargetApp,
  onSelectTarget,
  elementCandidates,
  elementCount,
  elementsLoading,
  elementsError,
  axQuality,
  onReloadElements,
}) => {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();
  const copy = t.localOps.computerUse;
  const diag = copy.diag;
  const providerTone: StatusTone = desktopProviderError
    ? 'blocked'
    : surface?.ready ? 'ready' : surface ? 'warning' : 'neutral';
  const sourceLabels: Record<ComputerUseTarget['source'], string> = {
    frontmost: diag.sourceFrontmost,
    surface: diag.sourceSurface,
    approved: diag.sourceApproved,
    denied: diag.sourceDenied,
    recent: diag.sourceRecent,
  };

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-950/30">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        data-testid="computer-use-diagnostics-toggle"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {copy.diagnostics}
      </Button>
      {!expanded && <p className="px-4 pb-3 text-xs text-zinc-500">{copy.diagnosticsHint}</p>}
      {expanded && (
        <div className="space-y-4 p-4" data-testid="computer-use-diagnostics">
          <div className="space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{diag.providerHeading}</div>
            <div className="grid gap-2 md:grid-cols-3">
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-zinc-200">{diag.nativeDesktop}</span>
                  <StatusPill
                    label={nativeAvailable ? diag.nativeOk : diag.nativeFallback}
                    tone={nativeAvailable ? 'ready' : 'warning'}
                  />
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  {capabilities ? `${capabilities.platform} · ${capabilities.phase}` : diag.nativeFallbackHint}
                </p>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-zinc-200">{diag.computerSurface}</span>
                  <StatusPill
                    label={surface?.mode || (desktopProviderError ? diag.unavailable : diag.unknown)}
                    tone={providerTone}
                  />
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  {surface?.safetyNote || desktopProviderError || diag.surfaceWaiting}
                </p>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-zinc-200">{diag.activityCollector}</span>
                  <StatusPill
                    label={collectorStatus?.running ? diag.collecting : collectorStatus ? diag.stopped : diag.unknown}
                    tone={collectorStatus?.running ? 'ready' : collectorStatus ? 'warning' : 'neutral'}
                  />
                </div>
                <p className="mt-1 text-xs text-zinc-500">{diag.collectorHint}</p>
              </div>
            </div>
            {observeError && (
              <p className="text-xs text-badge-warning">{diag.observeError}: {observeError}</p>
            )}
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-950/30">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <div className="flex items-center gap-2">
                <AppWindow className="h-4 w-4 text-badge-info" />
                <h3 className="text-sm font-medium text-zinc-200">{diag.targetsTitle}</h3>
              </div>
              <span className="text-[11px] text-zinc-500">{interpolate(diag.targetsCount, { count: targets.length })}</span>
            </div>
            {targets.length === 0 ? (
              <div className="p-6 text-sm text-zinc-500">{diag.targetsEmpty}</div>
            ) : (
              <div className="divide-y divide-zinc-800/80">
                {targets.map((target) => {
                  const selected = target.appName === selectedTargetApp;
                  return (
                    <button
                      key={target.id}
                      type="button"
                      onClick={() => onSelectTarget(target.appName)}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors ${
                        selected ? 'bg-badge-info' : 'hover:bg-zinc-800/40'
                      }`}
                    >
                      <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
                        selected ? 'bg-badge-info text-badge-info' : 'bg-zinc-800 text-zinc-500'
                      }`}>
                        <AppWindow className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-zinc-200">{target.appName}</span>
                          <span className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500">
                            {sourceLabels[target.source] ?? diag.sourceRecent}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-xs text-zinc-500">
                          {target.windowTitle || target.bundleId || diag.noWindowTitle}
                        </div>
                      </div>
                      <span className="shrink-0 text-[11px] text-zinc-600">{formatTime(target.capturedAtMs)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-950/30">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <div className="flex items-center gap-2">
                <SquareMousePointer className="h-4 w-4 text-badge-success" />
                <h3 className="text-sm font-medium text-zinc-200">{diag.axTitle}</h3>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!selectedTargetApp || elementsLoading}
                onClick={onReloadElements}
              >
                {elementsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                {diag.reload}
              </Button>
            </div>
            <div className="border-b border-zinc-800/80 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill
                  label={selectedTargetApp || diag.noAppSelected}
                  tone={selectedTargetApp ? 'neutral' : 'warning'}
                />
                {axQuality?.grade && (
                  <StatusPill
                    label={`AX ${axQuality.grade}`}
                    tone={axQuality.grade === 'good' ? 'ready' : axQuality.grade === 'usable' ? 'warning' : 'blocked'}
                  />
                )}
                <StatusPill
                  label={interpolate(diag.elementsPill, { count: elementCount })}
                  tone={elementCandidates.length > 0 ? 'ready' : elementsError ? 'blocked' : 'neutral'}
                />
              </div>
              {Array.isArray(axQuality?.reasons) && axQuality.reasons.length > 0 && (
                <p className="mt-2 text-xs text-badge-warning">{axQuality.reasons.slice(0, 2).join('; ')}</p>
              )}
              {elementsError && <p className="mt-2 text-xs text-badge-danger">{elementsError}</p>}
            </div>
            {elementsLoading ? (
              <div className="flex items-center justify-center p-6 text-sm text-zinc-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {diag.axLoading}
              </div>
            ) : elementCandidates.length === 0 ? (
              <div className="p-6 text-sm text-zinc-500">{diag.axEmpty}</div>
            ) : (
              <div className="divide-y divide-zinc-800/80">
                {elementCandidates.map((candidate) => (
                  <div key={candidate.id} className="grid grid-cols-[120px_minmax(0,1fr)_110px] gap-3 px-4 py-2.5 text-xs">
                    <span className="truncate font-mono text-zinc-500">{candidate.role}</span>
                    <span className="truncate text-zinc-200">{candidate.label}</span>
                    <span className="truncate text-right font-mono text-zinc-600">
                      {candidate.axPath || (candidate.enabled === false ? diag.disabled : diag.noAxPath)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
