import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  AlertTriangle,
  Circle,
  Eye,
  Loader2,
  Lock,
  MousePointerClick,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ZapOff,
} from 'lucide-react';
import {
  getFrontmostDesktopContext,
  getNativeDesktopCapabilities,
  getNativeDesktopCollectorStatus,
  getNativeDesktopPermissionStatus,
  isNativeDesktopAvailable,
  listComputerSurfaceElements,
  listRecentNativeDesktopEvents,
  observeComputerSurface,
  openNativeDesktopSystemSettings,
  readComputerSurfaceState,
  type ComputerSurfaceElementsResult,
  type ComputerSurfaceState,
  type NativePermissionStatus,
} from '../../../services/nativeDesktop';
import { useLiveAgentPointer } from '../../../hooks/useLiveAgentPointer';
import type { AgentPointerEvent } from '@shared/contract/desktop';
import {
  buildComputerUseTargets,
  buildRecentComputerUseAction,
  describeComputerUseFailures,
  getNativePermissionStatus,
  type ComputerUseFailureExplanation,
} from '../../../utils/computerUseWorkbench';
import { AgentPointerPreviewCard, AgentPointerTimelineList } from '../../workbench/AgentPointerOverlay';
import {
  COMPUTER_USE_SNAPSHOT_TTL_MS,
  consumeComputerUseSystemSettingsRefresh,
  getComputerUseSnapshot,
  invalidateComputerUseSnapshot,
  isComputerUseSnapshotStale,
  isComputerUseSystemSettingsRefreshPending,
  patchComputerUseSnapshot,
  subscribeComputerUseSnapshot,
  setComputerUseSnapshot,
} from '../../../stores/computerUseStore';
import { useI18n } from '../../../hooks/useI18n';
import {
  ComputerUseDiagnostics,
  StatusPill,
  toElementCandidates,
  statusToneClass,
  type StatusTone,
} from './ComputerUseDiagnostics';

function permissionTone(permission: NativePermissionStatus | null): StatusTone {
  if (!permission) return 'warning';
  if (permission.status === 'granted') return 'ready';
  if (['denied', 'needs_restart', 'wrong_bundle_id'].includes(permission.status)) return 'blocked';
  if (permission.status === 'unsupported') return 'neutral';
  return 'warning';
}

function permissionLabel(permission: NativePermissionStatus | null): string {
  if (!permission) return '未探测';
  switch (permission.status) {
    case 'granted':
      return '已授权';
    case 'denied':
      return '未授权';
    case 'needs_restart':
      return '需重启';
    case 'wrong_bundle_id':
      return 'Bundle 不匹配';
    case 'unsupported':
      return '不支持';
    default:
      return '未确认';
  }
}

function extractMetadataNumber(result: ComputerSurfaceElementsResult | null, key: string): number | null {
  const value = result?.metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function failureToneClass(tone: ComputerUseFailureExplanation['tone']): string {
  if (tone === 'blocked') return 'border-badge-danger/20 bg-badge-danger text-badge-danger';
  if (tone === 'warning') return 'border-badge-warning/20 bg-badge-warning text-badge-warning';
  return 'border-zinc-700/60 bg-zinc-900/60 text-zinc-300';
}

const BoundaryCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  detail: string;
  tone: StatusTone;
}> = ({ icon, title, detail, tone }) => (
  <div className={`rounded-lg border p-3 ${statusToneClass(tone)}`}>
    <div className="flex items-center gap-2 text-sm font-medium">
      {icon}
      {title}
    </div>
    <p className="mt-1 text-xs leading-relaxed opacity-80">{detail}</p>
  </div>
);

function createUnavailableSurfaceState(): ComputerSurfaceState {
  return {
    id: 'computer-surface-web-unavailable',
    mode: 'background_surface_unavailable',
    platform: 'web',
    ready: false,
    background: false,
    approvalScope: 'blocked',
    safetyNote: '网页版读不到桌面状态；这里只说明电脑操作的能力范围和不可用的原因。',
    targetApp: null,
    blockedReason: '网页版里无法读取桌面状态',
    approvedApps: [],
    deniedApps: [],
    lastAction: null,
    lastSnapshot: null,
    failureKind: 'evidence_unavailable',
    blockingReasons: ['网页版里无法读取桌面状态'],
    recommendedAction: '在桌面壳中打开后再读取窗口、截图和 AX evidence。',
    evidenceSummary: ['网页版里读不到桌面信息'],
    axQuality: null,
  };
}

// 桌面操作内容组件：嵌进「本机操作」合并页（features/localOps/LocalOpsPage）的桌面 tab，
// 不再自带 FullScreenPage 外壳；页面标题与关闭由外层页头负责，原页头的「诊断」角标和刷新按钮
// 收进左栏顶部的工具行。
export const ComputerUseContent: React.FC = () => {
  const snapshot = useSyncExternalStore(
    subscribeComputerUseSnapshot,
    getComputerUseSnapshot,
    getComputerUseSnapshot,
  );
  const nativeAvailable = snapshot?.nativeAvailable ?? false;
  const capabilities = snapshot?.capabilities ?? null;
  const permissionSnapshot = snapshot?.permissionSnapshot ?? null;
  const collectorStatus = snapshot?.collectorStatus ?? null;
  const frontmost = snapshot?.frontmost ?? null;
  const recentEvents = snapshot?.recentEvents ?? [];
  const surface = snapshot?.surface ?? null;
  const observation = snapshot?.observation ?? null;
  const desktopProviderError = snapshot?.desktopProviderError ?? null;
  const observeError = snapshot?.observeError ?? null;
  const [elementsResult, setElementsResult] = useState<ComputerSurfaceElementsResult | null>(null);
  const [elementsError, setElementsError] = useState<string | null>(null);
  const [selectedTargetApp, setSelectedTargetApp] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !getComputerUseSnapshot());
  const [refreshing, setRefreshing] = useState(false);
  const [elementsLoading, setElementsLoading] = useState(false);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const livePointer = useLiveAgentPointer('computer');

  const refresh = useCallback(() => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;

    setRefreshing(true);
    const previous = getComputerUseSnapshot();
    const hasNative = isNativeDesktopAvailable();
    const refreshPromise = (async () => {
      if (!hasNative) {
        setComputerUseSnapshot({
          capturedAtMs: Date.now(),
          nativeAvailable: false,
          capabilities: null,
          permissionSnapshot: null,
          collectorStatus: null,
          frontmost: null,
          recentEvents: [],
          surface: createUnavailableSurfaceState(),
          observation: null,
          desktopProviderError: 'Web 模式没有 native desktop bridge',
          observeError: null,
        });
        return;
      }

      const [
        surfaceResponse,
        observeResponse,
        capabilitiesResult,
        permissionsResult,
        collectorResult,
        frontmostResult,
        eventsResult,
      ] = await Promise.allSettled([
        readComputerSurfaceState(),
        observeComputerSurface({ includeScreenshot: false }),
        getNativeDesktopCapabilities(),
        getNativeDesktopPermissionStatus(),
        getNativeDesktopCollectorStatus(),
        getFrontmostDesktopContext(),
        listRecentNativeDesktopEvents(40),
      ]);

      let nextSurface = previous?.surface ?? null;
      let nextObservation = previous?.observation ?? null;
      let desktopProviderError: string | null = null;
      let observeError: string | null = null;
      let refreshSucceeded = true;

      if (surfaceResponse.status === 'fulfilled') {
        if (surfaceResponse.value.success && surfaceResponse.value.data) {
          nextSurface = surfaceResponse.value.data;
        } else {
          refreshSucceeded = false;
          desktopProviderError = surfaceResponse.value.error?.message || 'Computer Surface state unavailable';
        }
      } else {
        refreshSucceeded = false;
        desktopProviderError = surfaceResponse.reason instanceof Error ? surfaceResponse.reason.message : String(surfaceResponse.reason);
      }

      if (observeResponse.status === 'fulfilled') {
        const response = observeResponse.value;
        if (response.success && response.data) {
          nextObservation = response.data;
          nextSurface = response.data.state || nextSurface;
        } else {
          refreshSucceeded = false;
          observeError = response.error?.message || 'observeComputerSurface failed';
          if (response.data?.state) {
            nextSurface = response.data.state;
          }
        }
      } else {
        refreshSucceeded = false;
        observeError = observeResponse.reason instanceof Error ? observeResponse.reason.message : String(observeResponse.reason);
      }

      const nextCapabilities = capabilitiesResult.status === 'fulfilled'
        ? capabilitiesResult.value
        : previous?.capabilities ?? null;
      const nextPermissionSnapshot = permissionsResult.status === 'fulfilled'
        ? permissionsResult.value
        : previous?.permissionSnapshot ?? null;
      const nextCollectorStatus = collectorResult.status === 'fulfilled'
        ? collectorResult.value
        : previous?.collectorStatus ?? null;
      const nextFrontmost = frontmostResult.status === 'fulfilled'
        ? frontmostResult.value
        : previous?.frontmost ?? null;
      const nextRecentEvents = eventsResult.status === 'fulfilled'
        ? eventsResult.value
        : previous?.recentEvents ?? [];

      if (capabilitiesResult.status !== 'fulfilled') refreshSucceeded = false;
      if (permissionsResult.status !== 'fulfilled') refreshSucceeded = false;
      if (collectorResult.status !== 'fulfilled') refreshSucceeded = false;
      if (frontmostResult.status !== 'fulfilled') refreshSucceeded = false;
      if (eventsResult.status !== 'fulfilled') refreshSucceeded = false;

      setComputerUseSnapshot({
        capturedAtMs: refreshSucceeded ? Date.now() : previous?.capturedAtMs ?? 0,
        nativeAvailable: true,
        capabilities: nextCapabilities,
        permissionSnapshot: nextPermissionSnapshot,
        collectorStatus: nextCollectorStatus,
        frontmost: nextFrontmost,
        recentEvents: nextRecentEvents,
        surface: nextSurface,
        observation: nextObservation,
        desktopProviderError,
        observeError,
      });
    })().finally(() => {
      setLoading(false);
      setRefreshing(false);
      refreshInFlightRef.current = null;
    });
    refreshInFlightRef.current = refreshPromise;
    return refreshPromise;
  }, []);

  const loadElements = useCallback(async (targetApp: string | null) => {
    setElementsResult(null);
    setElementsError(null);
    if (!targetApp) {
      return;
    }

    setElementsLoading(true);
    try {
      const response = await listComputerSurfaceElements({
        targetApp,
        limit: 16,
        maxDepth: 4,
      });
      if (response.success && response.data) {
        setElementsResult(response.data);
        if (response.data.state) {
          patchComputerUseSnapshot({ surface: response.data.state });
        }
      } else {
        setElementsError(response.error?.message || 'listComputerSurfaceElements failed');
        if (response.data) {
          setElementsResult(response.data);
          if (response.data.state) {
            patchComputerUseSnapshot({ surface: response.data.state });
          }
        }
      }
    } catch (error) {
      setElementsError(error instanceof Error ? error.message : String(error));
    } finally {
      setElementsLoading(false);
    }
  }, []);

  useEffect(() => {
    // 如果本页是在系统设置已经关闭后才重新挂载，消费掉旧的 pending 标记；
    // stale effect 仍会立即触发一次后台刷新。
    consumeComputerUseSystemSettingsRefresh();
  }, []);

  useEffect(() => {
    if (isComputerUseSystemSettingsRefreshPending()) return;
    const current = getComputerUseSnapshot();
    if (!current || isComputerUseSnapshotStale(current)) {
      void refresh();
      return;
    }

    const remainingMs = current.capturedAtMs + COMPUTER_USE_SNAPSHOT_TTL_MS - Date.now();
    if (remainingMs <= 0) return;
    const timer = window.setTimeout(() => {
      invalidateComputerUseSnapshot();
      void refresh();
    }, remainingMs);
    return () => window.clearTimeout(timer);
  }, [refresh, snapshot?.capturedAtMs]);

  useEffect(() => {
    const refreshAfterSystemSettings = () => {
      if (document.visibilityState === 'hidden') return;
      const returnedFromSystemSettings = consumeComputerUseSystemSettingsRefresh();
      const current = getComputerUseSnapshot();
      if (returnedFromSystemSettings || isComputerUseSnapshotStale(current)) {
        void refresh();
      }
    };
    window.addEventListener('focus', refreshAfterSystemSettings);
    document.addEventListener('visibilitychange', refreshAfterSystemSettings);
    return () => {
      window.removeEventListener('focus', refreshAfterSystemSettings);
      document.removeEventListener('visibilitychange', refreshAfterSystemSettings);
    };
  }, [refresh]);

  const targets = useMemo(
    () => buildComputerUseTargets({ frontmost, recentEvents, surface }),
    [frontmost, recentEvents, surface],
  );

  useEffect(() => {
    if (targets.length === 0) {
      setSelectedTargetApp(null);
      return;
    }
    if (selectedTargetApp && targets.some((target) => target.appName === selectedTargetApp)) {
      return;
    }
    setSelectedTargetApp(targets[0].appName);
  }, [selectedTargetApp, targets]);

  useEffect(() => {
    void loadElements(selectedTargetApp);
  }, [loadElements, selectedTargetApp]);

  const actionSummary = useMemo(() => buildRecentComputerUseAction(surface), [surface]);
  const { t } = useI18n();
  const copy = t.localOps.computerUse;
  const elementCandidates = useMemo(
    () => toElementCandidates(elementsResult, copy.diag.unnamedElement),
    [elementsResult, copy.diag.unnamedElement],
  );
  const screenPermission = getNativePermissionStatus(permissionSnapshot, 'screenCapture');
  const accessibilityPermission = getNativePermissionStatus(permissionSnapshot, 'accessibility');
  const failureExplanations = useMemo(
    () => describeComputerUseFailures({
      nativeAvailable,
      desktopProviderError,
      capabilities,
      permissions: permissionSnapshot,
      surface,
      targets,
      selectedTargetApp,
      elementsError,
      observeError,
      // cua 默认 capture_mode=ax，录屏可选（§11.1）
      screenCaptureOptional: true,
    }),
    [
      capabilities,
      desktopProviderError,
      elementsError,
      nativeAvailable,
      observeError,
      permissionSnapshot,
      selectedTargetApp,
      surface,
      targets,
    ],
  );

  const axQuality = elementsResult?.metadata?.axQuality && typeof elementsResult.metadata.axQuality === 'object'
    ? elementsResult.metadata.axQuality as { grade?: string; elementCount?: number; reasons?: string[] }
    : surface?.axQuality || null;
  const metadataElementCount = extractMetadataNumber(elementsResult, 'elementCount');
  const pointerPreview = useMemo<AgentPointerEvent>(() => {
    if (livePointer.event) {
      return livePointer.event;
    }
    // idle 态优先停留在最后一次动作的位置（变暗），而非跳回合成预览点
    if (livePointer.lastEvent) {
      return livePointer.lastEvent;
    }
    if (actionSummary?.trace.agentPointerEvent) {
      return actionSummary.trace.agentPointerEvent;
    }
    const preview = actionSummary?.preview;
    const failed = Boolean(actionSummary?.trace.failureKind || surface?.failureKind);
    const targetLabel = preview?.target
      || selectedTargetApp
      || surface?.targetApp
      || observation?.snapshot?.appName
      || frontmost?.appName
      || copy.currentApp;
    return {
      id: actionSummary?.trace.id || 'computer-surface-pointer-preview',
      surface: 'computer',
      tone: failed ? 'blocked' : 'computer',
      phase: failed ? 'failed' : preview?.risk === 'read' ? 'read' : preview ? 'click' : 'preview',
      coordSpace: 'surfacePreview',
      point: { x: failed ? 52 : preview ? 44 : 38, y: failed ? 44 : 42, unit: 'percent' },
      targetLabel,
      targetSource: 'fallback',
      traceId: actionSummary?.trace.id || null,
      success: failed ? false : preview ? true : null,
    };
  }, [
    actionSummary?.preview,
    actionSummary?.trace.failureKind,
    actionSummary?.trace.agentPointerEvent,
    actionSummary?.trace.id,
    copy.currentApp,
    frontmost?.appName,
    livePointer.event,
    livePointer.lastEvent,
    observation?.snapshot?.appName,
    selectedTargetApp,
    surface?.failureKind,
    surface?.targetApp,
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="computer-use-content">
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {copy.loading}
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          <div className="w-[300px] shrink-0 border-r border-zinc-800 p-4 overflow-y-auto">
            <div className="mb-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  invalidateComputerUseSnapshot();
                  void refresh();
                }}
                disabled={refreshing}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
              >
                {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {copy.refresh}
              </button>
            </div>
            <div className="space-y-3">
              <BoundaryCard
                icon={<Eye className="h-4 w-4" />}
                title={copy.readTitle}
                detail={copy.readDetail}
                tone="ready"
              />
              <BoundaryCard
                icon={<ZapOff className="h-4 w-4" />}
                title={copy.actTitle}
                detail={copy.actDetail}
                tone="warning"
              />
            </div>

            <div className="mt-5 space-y-2">
              <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Permissions</div>

              {/* Accessibility = 必需。cua 走 AX 树优先，授权弹窗显示重签后的「Agent Neo Computer Use」 */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-zinc-200">Accessibility <span className="text-[10px] text-badge-info">必需</span></span>
                  <StatusPill label={permissionLabel(accessibilityPermission)} tone={permissionTone(accessibilityPermission)} />
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                  {accessibilityPermission?.detail || copy.accessibilityHint}
                  {accessibilityPermission?.status !== 'granted' && (
                    <span className="text-zinc-400">授权弹窗会显示 <span className="text-zinc-200">Agent Neo Computer Use</span>。</span>
                  )}
                </p>
                {accessibilityPermission?.status !== 'granted' && nativeAvailable && (
                  <button
                    type="button"
                    onClick={() => void openNativeDesktopSystemSettings('accessibility')}
                    className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md border border-badge-info/60 bg-badge-info px-2.5 text-[11px] text-badge-info hover:bg-badge-info"
                  >
                    <ShieldCheck className="h-3 w-3" />
                    开启辅助功能权限
                  </button>
                )}
              </div>

              {/* Screen Recording = 可选。默认 capture_mode=ax 不需要录屏（§11.1） */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-zinc-200">Screen Recording <span className="text-[10px] text-zinc-500">可选</span></span>
                  <StatusPill
                    label={screenPermission?.status === 'granted' ? '已授权' : '可选'}
                    tone={screenPermission?.status === 'granted' ? 'ready' : 'neutral'}
                  />
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                  {copy.screenHint}
                </p>
                {screenPermission?.status !== 'granted' && nativeAvailable && (
                  <button
                    type="button"
                    onClick={() => void openNativeDesktopSystemSettings('screenCapture')}
                    className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 text-[11px] text-zinc-300 hover:bg-zinc-700"
                  >
                    <Eye className="h-3 w-3" />
                    开启录屏（可选）
                  </button>
                )}
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-zinc-200">Automation</span>
                  <StatusPill label="按 app 单独授权" tone="warning" />
                </div>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                  {copy.automationHint}
                </p>
              </div>
            </div>
          </div>

          <div className="flex-1 min-w-0 overflow-y-auto">
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4 p-5">
              <div className="space-y-4">
                <section className="rounded-lg border border-zinc-800 bg-zinc-950/30">
                  <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
                    <AlertTriangle className="h-4 w-4 text-badge-warning" />
                    <h3 className="text-sm font-medium text-zinc-200">失败原因解释</h3>
                  </div>
                  <div className="grid gap-2 p-4 md:grid-cols-2">
                    {failureExplanations.map((item) => (
                      <div key={item.id} className={`rounded-lg border p-3 ${failureToneClass(item.tone)}`}>
                        <div className="flex items-center gap-2 text-sm font-medium">
                          {item.tone === 'blocked' ? <ShieldAlert className="h-4 w-4" /> : <Circle className="h-3.5 w-3.5" />}
                          {item.title}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed opacity-80">{item.detail}</p>
                      </div>
                    ))}
                  </div>
                </section>

                <ComputerUseDiagnostics
                  nativeAvailable={nativeAvailable}
                  capabilities={capabilities}
                  surface={surface}
                  collectorStatus={collectorStatus}
                  desktopProviderError={desktopProviderError}
                  observeError={observeError}
                  targets={targets}
                  selectedTargetApp={selectedTargetApp}
                  onSelectTarget={setSelectedTargetApp}
                  elementCandidates={elementCandidates}
                  elementCount={metadataElementCount ?? elementCandidates.length}
                  elementsLoading={elementsLoading}
                  elementsError={elementsError}
                  axQuality={axQuality}
                  onReloadElements={() => void loadElements(selectedTargetApp)}
                />
              </div>

              <aside className="space-y-4">
                <section className="rounded-lg border border-zinc-800 bg-zinc-950/30">
                  <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
                    <ShieldCheck className="h-4 w-4 text-badge-success" />
                    <h3 className="text-sm font-medium text-zinc-200">能力边界</h3>
                  </div>
                  <div className="space-y-2 p-4 text-xs leading-relaxed text-zinc-400">
                    <p>{copy.boundarySeen}</p>
                    <p>{copy.boundaryPage}</p>
                    <p>{copy.boundaryFlow}</p>
                  </div>
                </section>

                <section className="rounded-lg border border-zinc-800 bg-zinc-950/30">
                  <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
                    <MousePointerClick className="h-4 w-4 text-badge-info" />
                    <h3 className="text-sm font-medium text-zinc-200">{copy.lastActionTitle}</h3>
                  </div>
                  {actionSummary?.preview ? (
                    <div className="space-y-3 p-4">
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
                        <div className="text-sm text-zinc-100">{actionSummary.preview.summary}</div>
                        {actionSummary.preview.target && (
                          <div className="mt-1 truncate text-xs text-zinc-500">{actionSummary.preview.target}</div>
                        )}
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          <StatusPill label={actionSummary.preview.riskLabel} tone={actionSummary.preview.risk === 'read' ? 'ready' : 'warning'} />
                          <StatusPill label={actionSummary.preview.mode || actionSummary.trace.mode} tone="neutral" />
                          <StatusPill label={actionSummary.preview.scope} tone="neutral" />
                        </div>
                      </div>
                      {actionSummary.resultSummary && (
                        <p className="text-xs text-zinc-400">{actionSummary.resultSummary}</p>
                      )}
                      {actionSummary.trace.failureKind && (
                        <p className="rounded-lg border border-badge-danger/20 bg-badge-danger p-2 text-xs text-badge-danger">
                          {actionSummary.trace.failureKind}
                        </p>
                      )}
                      {actionSummary.trace.recommendedAction && (
                        <p className="rounded-lg border border-badge-warning/20 bg-badge-warning p-2 text-xs text-badge-warning">
                          {actionSummary.trace.recommendedAction}
                        </p>
                      )}
                      <div className="truncate text-[11px] text-zinc-600">trace {actionSummary.trace.id}</div>
                    </div>
                  ) : (
                    <div className="p-4 text-sm text-zinc-500">
                      {copy.lastActionEmpty}
                    </div>
                  )}
                </section>

                <AgentPointerPreviewCard
                  event={pointerPreview}
                  detail={t.localOps.pointer.computerDetail}
                  live={livePointer.isLive || !livePointer.lastEvent}
                />
                <AgentPointerTimelineList entries={livePointer.timeline} />

                <section className="rounded-lg border border-zinc-800 bg-zinc-950/30">
                  <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
                    <Lock className="h-4 w-4 text-zinc-400" />
                    <h3 className="text-sm font-medium text-zinc-200">当前窗口观察</h3>
                  </div>
                  <div className="space-y-2 p-4 text-xs text-zinc-400">
                    <div className="flex items-center justify-between gap-3">
                      <span>前台 app</span>
                      <span className="truncate text-zinc-200">{observation?.snapshot?.appName || frontmost?.appName || '未知'}</span>
                    </div>
                    <div className="flex items-start justify-between gap-3">
                      <span className="shrink-0">窗口</span>
                      <span className="min-w-0 text-right text-zinc-200">{observation?.snapshot?.windowTitle || frontmost?.windowTitle || '未知'}</span>
                    </div>
                  </div>
                </section>
              </aside>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
