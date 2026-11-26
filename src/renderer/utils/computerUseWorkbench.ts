import type { ToolCall } from '@shared/contract';
import type {
  ComputerSurfaceState,
  DesktopActivityEvent,
  FrontmostContextSnapshot,
  NativeDesktopCapabilities,
  NativePermissionSnapshot,
  NativePermissionStatus,
  WorkbenchActionTrace,
} from '../services/nativeDesktop';
import { interpolate } from '../i18n/interpolate';
import type { Language } from '../i18n';
import type { localOpsZh } from '../i18n/localOps';
import {
  buildBrowserComputerActionPreview,
  summarizeBrowserComputerActionResult,
  type BrowserComputerActionPreview,
} from './browserComputerActionPreview';

/** 页面文案（localOps.computerUse，zh/en 同形）：失败卡的 title/detail 全部由它拼出。 */
type ComputerUseCopy = typeof localOpsZh.localOps.computerUse;

type ComputerUseTargetSource = 'frontmost' | 'surface' | 'recent' | 'approved' | 'denied';

export interface ComputerUseTarget {
  id: string;
  appName: string;
  bundleId?: string | null;
  windowTitle?: string | null;
  capturedAtMs?: number | null;
  source: ComputerUseTargetSource;
  state?: 'approved' | 'denied' | null;
}

export interface ComputerUseActionTraceSummary {
  trace: WorkbenchActionTrace;
  preview: BrowserComputerActionPreview | null;
  resultSummary: string | null;
}

export interface ComputerUseFailureExplanation {
  id: string;
  title: string;
  detail: string;
  tone: 'blocked' | 'warning' | 'neutral';
}

export interface ComputerUseFailureInput {
  /** i18n 文案（localOps.computerUse）。util 内不落任何语言字面量。 */
  copy: ComputerUseCopy;
  nativeAvailable: boolean;
  desktopProviderError?: string | null;
  capabilities?: NativeDesktopCapabilities | null;
  permissions?: NativePermissionSnapshot | null;
  surface?: ComputerSurfaceState | null;
  targets: ComputerUseTarget[];
  selectedTargetApp?: string | null;
  elementsError?: string | null;
  observeError?: string | null;
  /** cua 走 capture_mode=ax 时置 true：把 Screen Recording 降为可选，不再当作阻断项。 */
  screenCaptureOptional?: boolean;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function makeTargetId(source: ComputerUseTargetSource, appName: string, windowTitle?: string | null): string {
  return [source, appName, windowTitle || ''].join(':');
}

function pushUniqueTarget(
  targets: ComputerUseTarget[],
  seen: Set<string>,
  target: Omit<ComputerUseTarget, 'id'>,
): void {
  const appName = target.appName.trim();
  if (!appName) {
    return;
  }
  const key = `${appName.toLowerCase()}::${target.windowTitle?.trim().toLowerCase() || ''}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  targets.push({
    ...target,
    appName,
    id: makeTargetId(target.source, appName, target.windowTitle),
  });
}

export function buildComputerUseTargets(input: {
  frontmost?: FrontmostContextSnapshot | null;
  recentEvents?: DesktopActivityEvent[];
  surface?: ComputerSurfaceState | null;
}): ComputerUseTarget[] {
  const targets: ComputerUseTarget[] = [];
  const seen = new Set<string>();

  const frontmostApp = asNonEmptyString(input.frontmost?.appName);
  if (frontmostApp) {
    pushUniqueTarget(targets, seen, {
      source: 'frontmost',
      appName: frontmostApp,
      bundleId: input.frontmost?.bundleId || null,
      windowTitle: input.frontmost?.windowTitle || input.frontmost?.browserTitle || null,
      capturedAtMs: input.frontmost?.capturedAtMs || null,
    });
  }

  const surfaceTarget = asNonEmptyString(input.surface?.targetApp);
  if (surfaceTarget) {
    pushUniqueTarget(targets, seen, {
      source: 'surface',
      appName: surfaceTarget,
      windowTitle: input.surface?.lastSnapshot?.windowTitle || null,
      capturedAtMs: input.surface?.lastSnapshot?.capturedAtMs || null,
    });
  }

  const snapshotApp = asNonEmptyString(input.surface?.lastSnapshot?.appName);
  if (snapshotApp) {
    pushUniqueTarget(targets, seen, {
      source: 'surface',
      appName: snapshotApp,
      windowTitle: input.surface?.lastSnapshot?.windowTitle || null,
      capturedAtMs: input.surface?.lastSnapshot?.capturedAtMs || null,
    });
  }

  for (const appName of input.surface?.approvedApps || []) {
    if (asNonEmptyString(appName)) {
      pushUniqueTarget(targets, seen, {
        source: 'approved',
        appName,
        state: 'approved',
      });
    }
  }

  for (const appName of input.surface?.deniedApps || []) {
    if (asNonEmptyString(appName)) {
      pushUniqueTarget(targets, seen, {
        source: 'denied',
        appName,
        state: 'denied',
      });
    }
  }

  const recent = [...(input.recentEvents || [])]
    .sort((a, b) => b.capturedAtMs - a.capturedAtMs)
    .slice(0, 24);
  for (const event of recent) {
    const appName = asNonEmptyString(event.appName);
    if (!appName) {
      continue;
    }
    pushUniqueTarget(targets, seen, {
      source: 'recent',
      appName,
      bundleId: event.bundleId || null,
      windowTitle: event.windowTitle || event.browserTitle || null,
      capturedAtMs: event.capturedAtMs,
    });
    if (targets.length >= 12) {
      break;
    }
  }

  return targets;
}

export function getNativePermissionStatus(
  snapshot: NativePermissionSnapshot | null | undefined,
  kind: string,
): NativePermissionStatus | null {
  return snapshot?.permissions.find((permission) => permission.kind === kind) || null;
}

function getPermissionCopy(kind: string, copy: ComputerUseCopy): string {
  if (kind === 'screenCapture') return copy.permScreenRecording;
  if (kind === 'accessibility') return copy.permAccessibility;
  return kind;
}

function addExplanation(
  items: ComputerUseFailureExplanation[],
  item: ComputerUseFailureExplanation,
): void {
  if (!items.some((existing) => existing.id === item.id)) {
    items.push(item);
  }
}

function explainPermission(
  items: ComputerUseFailureExplanation[],
  permission: NativePermissionStatus | null,
  kind: 'screenCapture' | 'accessibility',
  copy: ComputerUseCopy,
  optional = false,
): void {
  const label = getPermissionCopy(kind, copy);
  const fail = copy.fail;
  // cua 默认 capture_mode=ax（只读 AX 树，免录屏）。录屏是可选增强：未授权不阻断，
  // 仅提示「需要视觉消歧时再开」。详见 内部文档 §11.1。
  // 原生 detail（英文系统文案）只进「诊断」区，默认卡一律用本地化提示。
  if (optional && (permission?.status !== 'granted')) {
    addExplanation(items, {
      id: `${kind}:optional`,
      title: interpolate(fail.permOptionalTitle, { name: label }),
      detail: fail.permOptionalDetail,
      tone: 'neutral',
    });
    return;
  }
  if (!permission) {
    addExplanation(items, {
      id: `${kind}:unknown`,
      title: interpolate(fail.permUnknownTitle, { name: label }),
      detail: fail.permUnknownDetail,
      tone: 'warning',
    });
    return;
  }

  if (permission.status === 'granted') {
    return;
  }

  if (permission.status === 'unsupported') {
    addExplanation(items, {
      id: `${kind}:unsupported`,
      title: interpolate(fail.permUnsupportedTitle, { name: label }),
      detail: fail.permUnsupportedDetail,
      tone: 'neutral',
    });
    return;
  }

  if (permission.status === 'needs_restart') {
    addExplanation(items, {
      id: `${kind}:needs_restart`,
      title: interpolate(fail.permNeedsRestartTitle, { name: label }),
      detail: interpolate(fail.permNeedsRestartDetail, { name: label }),
      tone: 'blocked',
    });
    return;
  }

  if (permission.status === 'wrong_bundle_id') {
    addExplanation(items, {
      id: `${kind}:wrong_bundle_id`,
      title: interpolate(fail.permWrongBundleTitle, { name: label }),
      detail: interpolate(fail.permWrongBundleDetail, { name: label }),
      tone: 'blocked',
    });
    return;
  }

  addExplanation(items, {
    id: `${kind}:${permission.status}`,
    title: interpolate(
      permission.status === 'denied' ? fail.permDeniedTitle : fail.permUnconfirmedTitle,
      { name: label },
    ),
    detail: interpolate(
      permission.status === 'denied' ? fail.permDeniedDetail : fail.permUnconfirmedDetail,
      { name: label },
    ),
    tone: permission.status === 'denied' ? 'blocked' : 'warning',
  });
}

/** failureKind → 展示色调（语言无关的表现层语义，不进文案字典）。 */
const FAILURE_KIND_TONES: Record<string, ComputerUseFailureExplanation['tone']> = {
  permission_denied: 'blocked',
  target_app_not_running: 'blocked',
  target_not_frontmost: 'warning',
  target_window_not_found: 'blocked',
  ax_unavailable: 'blocked',
  ax_tree_poor: 'warning',
  locator_missing: 'warning',
  locator_ambiguous: 'warning',
  coordinate_untrusted: 'blocked',
  action_execution_failed: 'blocked',
};

function explainFailureKind(kind: string, copy: ComputerUseCopy): Omit<ComputerUseFailureExplanation, 'id'> {
  const text = copy.fail.kinds[kind as keyof typeof copy.fail.kinds] ?? copy.fail.kinds.default;
  return { ...text, tone: FAILURE_KIND_TONES[kind] ?? 'warning' };
}

export function buildRecentComputerUseAction(
  surface: ComputerSurfaceState | null | undefined,
  locale?: Language,
): ComputerUseActionTraceSummary | null {
  const trace = surface?.lastAction;
  if (!trace) {
    return null;
  }

  const mode = trace.mode || surface?.mode || 'foreground_fallback';
  const metadata: Record<string, unknown> = {
    computerSurfaceMode: mode,
    workbenchTrace: {
      id: trace.id,
      mode,
    },
    targetApp: surface?.targetApp || undefined,
    failureKind: trace.failureKind || undefined,
    blockingReasons: trace.blockingReasons,
    recommendedAction: trace.recommendedAction || undefined,
    axQuality: trace.axQuality || undefined,
  };
  if (mode === 'background_ax') {
    metadata.backgroundSurface = true;
  }
  if (mode === 'foreground_fallback') {
    metadata.foregroundFallback = true;
  }

  const toolCall: ToolCall = {
    id: trace.id,
    name: trace.targetKind === 'browser' && trace.toolName === 'browser_action'
      ? 'browser_action'
      : 'computer_use',
    arguments: {
      action: trace.action || 'get_state',
      targetApp: surface?.targetApp || undefined,
    },
    result: {
      toolCallId: trace.id,
      success: !trace.failureKind,
      error: trace.failureKind || undefined,
      output: trace.evidenceSummary?.join('\n') || '',
      metadata,
    },
  };

  return {
    trace,
    preview: buildBrowserComputerActionPreview(toolCall, locale),
    resultSummary: summarizeBrowserComputerActionResult(toolCall, locale),
  };
}

export function describeComputerUseFailures(input: ComputerUseFailureInput): ComputerUseFailureExplanation[] {
  const items: ComputerUseFailureExplanation[] = [];
  const fail = input.copy.fail;

  if (!input.nativeAvailable) {
    addExplanation(items, {
      id: 'native-runtime-unavailable',
      title: fail.webRuntimeTitle,
      detail: fail.webRuntimeDetail,
      tone: 'warning',
    });
  }

  if (input.desktopProviderError) {
    addExplanation(items, {
      id: 'desktop-provider-error',
      title: fail.providerErrorTitle,
      detail: fail.providerErrorDetail,
      tone: 'blocked',
    });
  }

  if (input.capabilities && !input.capabilities.supportsFrontmostContext) {
    addExplanation(items, {
      id: 'frontmost-unsupported',
      title: fail.frontmostUnsupportedTitle,
      detail: fail.frontmostUnsupportedDetail,
      tone: 'warning',
    });
  }

  explainPermission(items, getNativePermissionStatus(input.permissions, 'screenCapture'), 'screenCapture', input.copy, input.screenCaptureOptional);
  explainPermission(items, getNativePermissionStatus(input.permissions, 'accessibility'), 'accessibility', input.copy);

  addExplanation(items, {
    id: 'automation-per-app',
    title: interpolate(fail.automationTitle, { name: input.copy.permAutomation }),
    detail: fail.automationDetail,
    tone: 'neutral',
  });

  if (!input.surface) {
    addExplanation(items, {
      id: 'surface-missing',
      title: fail.surfaceMissingTitle,
      detail: fail.surfaceMissingDetail,
      tone: 'blocked',
    });
  }

  const surface = input.surface;
  if (surface?.blockedReason) {
    addExplanation(items, {
      id: 'surface-blocked',
      title: fail.surfaceBlockedTitle,
      detail: surface.blockedReason,
      tone: 'blocked',
    });
  }

  if (surface?.failureKind) {
    addExplanation(items, {
      id: `failure:${surface.failureKind}`,
      ...explainFailureKind(surface.failureKind, input.copy),
    });
  }

  for (const reason of surface?.blockingReasons || []) {
    addExplanation(items, {
      id: `blocking:${reason}`,
      title: fail.blockingTitle,
      detail: reason,
      tone: 'blocked',
    });
  }

  if (surface?.mode === 'foreground_fallback' || surface?.requiresForeground) {
    addExplanation(items, {
      id: 'foreground-fallback',
      title: fail.foregroundFallbackTitle,
      detail: fail.foregroundFallbackDetail,
      tone: 'warning',
    });
  }

  if (surface?.mode === 'background_surface_unavailable') {
    addExplanation(items, {
      id: 'background-unavailable',
      title: fail.backgroundUnavailableTitle,
      detail: surface.safetyNote || fail.backgroundUnavailableDetail,
      tone: 'blocked',
    });
  }

  if (surface?.axQuality?.grade === 'poor') {
    addExplanation(items, {
      id: 'ax-quality-poor',
      title: fail.axQualityPoorTitle,
      detail: fail.axQualityPoorDetail,
      tone: 'warning',
    });
  }

  if (input.elementsError) {
    addExplanation(items, {
      id: 'elements-error',
      title: fail.elementsErrorTitle,
      detail: input.selectedTargetApp
        ? interpolate(fail.elementsErrorWithAppDetail, { app: input.selectedTargetApp })
        : fail.elementsErrorDetail,
      tone: 'blocked',
    });
  }

  if (input.observeError) {
    addExplanation(items, {
      id: 'observe-error',
      title: fail.observeErrorTitle,
      detail: fail.observeErrorDetail,
      tone: 'warning',
    });
  }

  if (input.targets.length === 0) {
    addExplanation(items, {
      id: 'no-targets',
      title: fail.noTargetsTitle,
      detail: fail.noTargetsDetail,
      tone: 'neutral',
    });
  }

  return items;
}
