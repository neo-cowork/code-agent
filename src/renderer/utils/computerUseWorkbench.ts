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
import {
  buildBrowserComputerActionPreview,
  summarizeBrowserComputerActionResult,
  type BrowserComputerActionPreview,
} from './browserComputerActionPreview';

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

function getPermissionCopy(kind: string): string {
  if (kind === 'screenCapture') return 'Screen Recording';
  if (kind === 'accessibility') return 'Accessibility';
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
  optional = false,
): void {
  const label = getPermissionCopy(kind);
  // cua 默认 capture_mode=ax（只读 AX 树，免录屏）。录屏是可选增强：未授权不阻断，
  // 仅提示「需要视觉消歧时再开」。详见 内部文档 §11.1。
  if (optional && (permission?.status !== 'granted')) {
    addExplanation(items, {
      id: `${kind}:optional`,
      title: `${label} 可选`,
      detail: '默认无需录屏权限。仅当需要截图辅助判断时再单独授权。',
      tone: 'neutral',
    });
    return;
  }
  if (!permission) {
    addExplanation(items, {
      id: `${kind}:unknown`,
      title: `${label} 未探测`,
      detail: '当前页还没有拿到 macOS 权限状态，只能展示降级原因，不能判断截图或界面内容的读取是否可靠。',
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
      title: `${label} 当前平台不支持`,
      detail: permission.detail || '这个权限只在 macOS 桌面 runtime 下可用。',
      tone: 'neutral',
    });
    return;
  }

  if (permission.status === 'needs_restart') {
    addExplanation(items, {
      id: `${kind}:needs_restart`,
      title: `${label} 需要重启`,
      detail: permission.detail || `${label} 授权后需要重启 Agent Neo 才能生效。`,
      tone: 'blocked',
    });
    return;
  }

  if (permission.status === 'wrong_bundle_id') {
    addExplanation(items, {
      id: `${kind}:wrong_bundle_id`,
      title: `${label} Bundle 不匹配`,
      detail: permission.detail || `${label} 授权落在了另一个包上，请给当前运行包重新授权。`,
      tone: 'blocked',
    });
    return;
  }

  addExplanation(items, {
    id: `${kind}:${permission.status}`,
    title: `${label} ${permission.status === 'denied' ? '未授权' : '未确认'}`,
    detail: permission.detail || `${label} 状态未确认，窗口截图、界面内容或浏览器信息的读取可能失败。`,
    tone: permission.status === 'denied' ? 'blocked' : 'warning',
  });
}

function explainFailureKind(kind: string): Omit<ComputerUseFailureExplanation, 'id'> {
  switch (kind) {
    case 'permission_denied':
      return {
        title: '权限未开',
        detail: 'macOS 拒绝了 Neo 读取或控制屏幕。通常要检查「辅助功能」和「屏幕录制」权限。',
        tone: 'blocked',
      };
    case 'target_app_not_running':
      return {
        title: '目标 app 没运行',
        detail: '目标 app 现在没有打开，先启动它并让窗口出现。',
        tone: 'blocked',
      };
    case 'target_not_frontmost':
      return {
        title: '目标不在前台',
        detail: '目标 app 不在最前面时，Neo 不会替你点击或输入，先把它切到前台。',
        tone: 'warning',
      };
    case 'target_window_not_found':
      return {
        title: '窗口不可读',
        detail: '这个窗口已经关闭或变化了，请刷新后重新选择窗口。',
        tone: 'blocked',
      };
    case 'ax_unavailable':
      return {
        title: '读不到界面元素',
        detail: '这个 app 没有提供可读的界面内容，或辅助功能权限不足。Electron、CEF、WKWebView 壳常见只暴露很浅的容器。',
        tone: 'blocked',
      };
    case 'ax_tree_poor':
      return {
        title: '界面元素信息太少',
        detail: '屏幕上的元素缺少名称或类型，自动定位容易点错。Electron、CEF、WKWebView 壳也常见这种情况；先展示原因，避免直接执行。',
        tone: 'warning',
      };
    case 'locator_missing':
      return {
        title: '目标元素找不到',
        detail: '没有找到要操作的那个元素。需要重新读取屏幕上的元素，或重新观察前台窗口。',
        tone: 'warning',
      };
    case 'locator_ambiguous':
      return {
        title: '目标元素不唯一',
        detail: '有多个元素同时符合，需要指定得更具体一些。',
        tone: 'warning',
      };
    case 'coordinate_untrusted':
      return {
        title: '坐标不可信',
        detail: '窗口位置和当前屏幕内容对不上，不能把按位置点击当成可靠的后台操作。',
        tone: 'blocked',
      };
    case 'action_execution_failed':
      return {
        title: '动作执行失败',
        detail: '系统没能完成这一步操作。当前页只展示失败原因，不会自动重试。',
        tone: 'blocked',
      };
    default:
      return {
        title: '证据不可用',
        detail: '没有足够的窗口或屏幕信息来支撑电脑操作。',
        tone: 'warning',
      };
  }
}

export function buildRecentComputerUseAction(
  surface: ComputerSurfaceState | null | undefined,
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
    name: 'computer_use',
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
    preview: buildBrowserComputerActionPreview(toolCall),
    resultSummary: summarizeBrowserComputerActionResult(toolCall),
  };
}

export function describeComputerUseFailures(input: ComputerUseFailureInput): ComputerUseFailureExplanation[] {
  const items: ComputerUseFailureExplanation[] = [];

  if (!input.nativeAvailable) {
    addExplanation(items, {
      id: 'native-runtime-unavailable',
      title: '当前是网页版',
      detail: '在网页版里，macOS 权限、前台 app 和系统设置入口都读取不到，请在桌面版里打开本页。',
      tone: 'warning',
    });
  }

  if (input.desktopProviderError) {
    addExplanation(items, {
      id: 'desktop-provider-error',
      title: '桌面能力没有响应',
      detail: '读取桌面状态时出错了，展开「诊断」可以看到原始信息。',
      tone: 'blocked',
    });
  }

  if (input.capabilities && !input.capabilities.supportsFrontmostContext) {
    addExplanation(items, {
      id: 'frontmost-unsupported',
      title: '前台窗口上下文不可读',
      detail: '当前环境读不到最前面的应用和窗口，窗口列表只能显示最近活动，或者为空。',
      tone: 'warning',
    });
  }

  explainPermission(items, getNativePermissionStatus(input.permissions, 'screenCapture'), 'screenCapture', input.screenCaptureOptional);
  explainPermission(items, getNativePermissionStatus(input.permissions, 'accessibility'), 'accessibility');

  addExplanation(items, {
    id: 'automation-per-app',
    title: 'Automation 是按目标 app 授权',
    detail: 'macOS 没有统一的自动化开关。读取浏览器网址等操作会按目标 app 分别询问或失败，当前页只说明这一点。',
    tone: 'neutral',
  });

  if (!input.surface) {
    addExplanation(items, {
      id: 'surface-missing',
      title: '还没读到屏幕状态',
      detail: '没有读到屏幕状态，暂时无法判断能不能在后台操作。',
      tone: 'blocked',
    });
  }

  const surface = input.surface;
  if (surface?.blockedReason) {
    addExplanation(items, {
      id: 'surface-blocked',
      title: '屏幕操作被阻止',
      detail: surface.blockedReason,
      tone: 'blocked',
    });
  }

  if (surface?.failureKind) {
    addExplanation(items, {
      id: `failure:${surface.failureKind}`,
      ...explainFailureKind(surface.failureKind),
    });
  }

  for (const reason of surface?.blockingReasons || []) {
    addExplanation(items, {
      id: `blocking:${reason}`,
      title: '阻塞原因',
      detail: reason,
      tone: 'blocked',
    });
  }

  if (surface?.mode === 'foreground_fallback' || surface?.requiresForeground) {
    addExplanation(items, {
      id: 'foreground-fallback',
      title: '只能前台兜底',
      detail: '当前只能作用在最前面的窗口。目标 app 不在前台或焦点被抢走时，不会自动点击或输入。',
      tone: 'warning',
    });
  }

  if (surface?.mode === 'background_surface_unavailable') {
    addExplanation(items, {
      id: 'background-unavailable',
      title: '暂时不能在后台操作',
      detail: surface.safetyNote || '当前不能在后台操作，只能查看状态。',
      tone: 'blocked',
    });
  }

  if (surface?.axQuality?.grade === 'poor') {
    addExplanation(items, {
      id: 'ax-quality-poor',
      title: '界面元素信息太少',
      detail: '屏幕上的元素缺少名称，不能安全定位。展开「诊断」可以看到具体原因。',
      tone: 'warning',
    });
  }

  if (input.elementsError) {
    addExplanation(items, {
      id: 'elements-error',
      title: '读取屏幕元素失败',
      detail: input.selectedTargetApp
        ? `读取「${input.selectedTargetApp}」的界面元素时出错了，展开「诊断」可以看到原始信息。`
        : '读取界面元素时出错了，展开「诊断」可以看到原始信息。',
      tone: 'blocked',
    });
  }

  if (input.observeError) {
    addExplanation(items, {
      id: 'observe-error',
      title: '前台窗口观察失败',
      detail: '观察前台窗口时出错了，展开「诊断」可以看到原始信息。',
      tone: 'warning',
    });
  }

  if (input.targets.length === 0) {
    addExplanation(items, {
      id: 'no-targets',
      title: '没有可展示的 app / 窗口',
      detail: '没有读到最前面的应用、最近的桌面活动或已批准的 app，当前页只能展示权限状态。',
      tone: 'neutral',
    });
  }

  return items;
}
