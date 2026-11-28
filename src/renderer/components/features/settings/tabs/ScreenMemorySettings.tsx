// ============================================================================
// ScreenMemorySettings — unified screen memory settings entry
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Circle, Clock, Globe2, Monitor, RefreshCw, Server, Shield, Sparkles, AlertTriangle } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import type {
  ActivityProviderDescriptor,
  ActivityProviderListResult,
  ActivityProviderState,
} from '@shared/contract/activityProvider';
import {
  isDesktopShellMode,
  isTauriMode,
  isWebMode,
} from '../../../../utils/platform';
import { createLogger } from '../../../../utils/logger';
import { WebModeBanner } from '../WebModeBanner';
import { SettingsDetails, SettingsPage, SettingsSection } from '../SettingsLayout';
import ipcService from '../../../../services/ipcService';
import { NativeDesktopSection } from '../sections/NativeDesktopSection';
import { MeetingCalendarReminderToggle } from '../sections/MeetingCalendarReminderToggle';
import { OpenchronicleSettings } from './OpenchronicleSettings';
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';
import {
  getCurrentActivityContext,
  type ActivityContextPreview,
  type ActivityContextSourcePreview,
} from '../../../../services/activityContext';

const logger = createLogger('ScreenMemorySettings');

interface StatusItem {
  label: string;
  value: string;
  tone: 'ready' | 'idle' | 'blocked';
}

const toneClass: Record<StatusItem['tone'], string> = {
  ready: 'border-badge-success/20 bg-emerald-500/10 text-badge-success',
  idle: 'border-zinc-700/50 bg-zinc-800/50 text-zinc-300',
  blocked: 'border-badge-warning/20 bg-amber-500/10 text-badge-warning',
};

type ProviderKind = ActivityProviderDescriptor['kind'];
type ScreenMemorySettingsText = typeof zh.settings.openchronicle.screenMemory;

function getProviderStateLabel(
  state: ActivityProviderState,
  labels: ScreenMemorySettingsText['providerStateLabels'] = zh.settings.openchronicle.screenMemory.providerStateLabels,
): string {
  return labels[state];
}

function buildEmptyActivityContext(
  labels: ScreenMemorySettingsText['activityContext']['empty'] = zh.settings.openchronicle.screenMemory.activityContext.empty,
): ActivityContextPreview {
  return {
    status: 'empty',
    recentContextSummary: labels.recentContextSummary,
    agentInjectionPreview: labels.agentInjectionPreview,
    sources: [],
    evidence: [],
  };
}

function stateTone(state?: ActivityProviderState): StatusItem['tone'] {
  if (state === 'running' || state === 'available') return 'ready';
  if (state === 'error' || state === 'unavailable') return 'blocked';
  return 'idle';
}

function stateDotClass(state?: ActivityProviderState): string {
  if (state === 'running' || state === 'available') return 'text-badge-success';
  if (state === 'starting' || state === 'stopping') return 'text-badge-warning';
  if (state === 'error' || state === 'unavailable') return 'text-badge-danger';
  return 'text-zinc-500';
}

function buildStatusItems(
  openchronicle?: ActivityProviderDescriptor,
  nativeDesktop?: ActivityProviderDescriptor,
  labels: ScreenMemorySettingsText['status'] = zh.settings.openchronicle.screenMemory.status,
  providerStateLabels: ScreenMemorySettingsText['providerStateLabels'] = zh.settings.openchronicle.screenMemory.providerStateLabels,
): StatusItem[] {
  const desktopShell = isDesktopShellMode();
  const tauri = isTauriMode();

  // 宿主在 metadata.installed 里如实报告配套程序装没装；没装时这一格直接说「未安装」。
  const openchronicleMissing = openchronicle?.metadata?.installed === false;

  return [
    {
      label: labels.currentRuntime,
      value: desktopShell ? labels.desktopApp : labels.webFallback,
      tone: desktopShell ? 'ready' : 'blocked',
    },
    {
      label: labels.automaticScreenMemory,
      value: openchronicleMissing
        ? labels.notInstalled
        : openchronicle
          ? getProviderStateLabel(openchronicle.state, providerStateLabels)
          : desktopShell ? labels.openchronicleConfigurable : labels.desktopAvailable,
      tone: !desktopShell || openchronicleMissing ? 'blocked' : stateTone(openchronicle?.state),
    },
    {
      label: labels.manualDesktopActivity,
      value: nativeDesktop
        ? getProviderStateLabel(nativeDesktop.state, providerStateLabels)
        : tauri ? labels.nativeDesktopAvailable : labels.tauriOnly,
      tone: tauri ? stateTone(nativeDesktop?.state) : 'idle',
    },
  ];
}

const ProviderHeading: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
  provider?: ActivityProviderDescriptor;
  fallbackKind?: ProviderKind;
}> = ({ icon, title, description, provider, fallbackKind }) => {
  const { t } = useI18n();
  const screenMemoryText = t.settings.openchronicle.screenMemory;
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 text-zinc-400">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
          {(provider || fallbackKind) && (
            <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400">
              {screenMemoryText.providerKindLabels[provider?.kind || fallbackKind!]}
            </span>
          )}
          {provider && (
            <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400">
              <Circle className={`h-2 w-2 fill-current stroke-0 ${stateDotClass(provider.state)}`} />
              {provider.metadata?.installed === false
                ? screenMemoryText.status.notInstalled
                : getProviderStateLabel(provider.state, screenMemoryText.providerStateLabels)}
            </span>
          )}
        </div>
        <p className="text-xs text-zinc-500 mt-1">{description}</p>
      </div>
    </div>
  );
};

const NativeDesktopUnavailable: React.FC = () => {
  const { t } = useI18n();
  const nativeUnavailableText = t.settings.openchronicle.screenMemory.nativeUnavailable;
  return (
    <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/60 p-4">
      <div className="flex items-start gap-2 text-sm text-zinc-300">
        <AlertTriangle className="w-4 h-4 mt-0.5 text-badge-warning shrink-0" />
        <div>
          <div className="font-medium">{nativeUnavailableText.title}</div>
          <p className="text-xs text-zinc-500 mt-1">
            {nativeUnavailableText.description}
          </p>
        </div>
      </div>
    </div>
  );
};

function formatCapturedAt(
  ms?: number | null,
  labels: ScreenMemorySettingsText['activityContext']['capturedAt'] = zh.settings.openchronicle.screenMemory.activityContext.capturedAt,
): string {
  if (!ms) return labels.none;
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

function SourceBadge({ source, label }: { source: ActivityContextSourcePreview; label: string }) {
  const className = {
    automatic_background: 'border-badge-info/20 bg-cyan-500/10 text-badge-info',
    manual_capture: 'border-badge-success/20 bg-emerald-500/10 text-badge-success',
    meeting_audio: 'border-badge-warning/20 bg-amber-500/10 text-badge-warning',
    screenshot_analysis: 'border-badge-accent/20 bg-purple-500/10 text-badge-accent',
    unknown: 'border-zinc-600 bg-zinc-800 text-zinc-400',
  }[source.kind];

  return (
    // 不再把 source.summary 挂成悬停提示：来源没内容时它是宿主的英文诊断原因，有内容时与下方预览重复。
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] ${className}`}>
      {label}
    </span>
  );
}

const PreviewBlock: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/60 p-3">
    <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">{title}</div>
    <div className="text-sm leading-relaxed text-zinc-300">{children}</div>
  </div>
);

export const ActivityContextPreviewPanel: React.FC<{
  context: ActivityContextPreview;
  degraded?: string | null;
}> = ({ context, degraded }) => {
  const { t } = useI18n();
  const activityText = t.settings.openchronicle.screenMemory.activityContext;
  return (
    <section className="rounded-lg border border-zinc-700 bg-zinc-800/40 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
            <Sparkles className="h-4 w-4 text-badge-info" />
            {activityText.title}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
            <Clock className="h-3.5 w-3.5" />
            {formatCapturedAt(context.capturedAtMs, activityText.capturedAt)}
          </div>
        </div>
        {degraded ? (
          <span className="rounded-md border border-badge-warning/20 bg-amber-500/10 px-2 py-1 text-[11px] text-badge-warning">
            {activityText.degraded}
          </span>
        ) : null}
      </div>

      {degraded ? (
        <div className="mb-3 rounded-lg border border-badge-warning/20 bg-amber-500/10 px-3 py-2 text-xs text-badge-warning">
          {degraded}
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap gap-1.5">
        {context.sources.length > 0 ? (
          context.sources.map((source, index) => (
            <SourceBadge key={`${source.kind}:${index}`} source={source} label={activityText.sourceLabels[source.kind]} />
          ))
        ) : (
          <span className="text-xs text-zinc-500">{activityText.noSources}</span>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <PreviewBlock title={activityText.recentContextPreview}>
          {context.recentContextSummary}
        </PreviewBlock>
        <PreviewBlock title={activityText.agentInjectionPreview}>
          {context.agentInjectionPreview}
        </PreviewBlock>
      </div>

      <div className="mt-3 flex items-start gap-2 rounded-lg border border-zinc-700/60 bg-zinc-900/50 px-3 py-2">
        <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
        <div className="min-w-0 text-xs text-zinc-500">
          {context.evidence.length > 0
            ? context.evidence.join(' · ')
            : activityText.evidenceFallback}
        </div>
      </div>
    </section>
  );
};

export const ScreenMemorySettings: React.FC = () => {
  const { t } = useI18n();
  const screenMemoryText = t.settings.openchronicle.screenMemory;
  const emptyActivityContext = useMemo(
    () => buildEmptyActivityContext(screenMemoryText.activityContext.empty),
    [screenMemoryText.activityContext.empty],
  );
  const [activityContext, setActivityContext] = useState<ActivityContextPreview>(
    () => buildEmptyActivityContext(screenMemoryText.activityContext.empty),
  );
  const [providers, setProviders] = useState<ActivityProviderDescriptor[]>([]);
  const [contextLoading, setContextLoading] = useState(true);
  const [contextFailed, setContextFailed] = useState(false);
  const web = isWebMode();
  const tauri = isTauriMode();

  const openchronicleProvider = useMemo(
    () => providers.find((provider) => provider.id === 'openchronicle'),
    [providers]
  );
  const nativeDesktopProvider = useMemo(
    () => providers.find((provider) => provider.id === 'tauri-native-desktop'),
    [providers]
  );
  const statusItems = buildStatusItems(
    openchronicleProvider,
    nativeDesktopProvider,
    screenMemoryText.status,
    screenMemoryText.providerStateLabels,
  );

  const refreshActivityContext = useCallback(async () => {
    setContextLoading(true);
    try {
      const [providerResult, contextResult] = await Promise.all([
        ipcService.invokeDomain<ActivityProviderListResult>(IPC_DOMAINS.ACTIVITY, 'listProviders'),
        getCurrentActivityContext(screenMemoryText.activityContext.sourceLabels),
      ]);
      setProviders(providerResult.providers);
      // 没有任何可参考内容时，服务层给的是它自己的占位句，界面换成语言包里的说法。
      setActivityContext(contextResult.status === 'empty'
        ? {
            ...contextResult,
            recentContextSummary: screenMemoryText.activityContext.nothingYet.recentContextSummary,
            agentInjectionPreview: screenMemoryText.activityContext.nothingYet.agentInjectionPreview,
          }
        : contextResult);
      setContextFailed(false);
    } catch (error) {
      logger.warn('activity context refresh failed', { detail: error instanceof Error ? error.message : String(error) });
      setContextFailed(true);
      setActivityContext({
        ...emptyActivityContext,
        recentContextSummary: screenMemoryText.activityContext.error.recentContextUnavailable,
        agentInjectionPreview: screenMemoryText.activityContext.error.agentInjectionUnavailable,
      });
    } finally {
      setContextLoading(false);
    }
  }, [emptyActivityContext, screenMemoryText.activityContext.error.agentInjectionUnavailable, screenMemoryText.activityContext.error.recentContextUnavailable, screenMemoryText.activityContext.nothingYet.agentInjectionPreview, screenMemoryText.activityContext.nothingYet.recentContextSummary, screenMemoryText.activityContext.sourceLabels]);

  useEffect(() => {
    if (!web) {
      refreshActivityContext();
    }
  }, [refreshActivityContext, web]);

  if (web) {
    return (
      <SettingsPage
        title={t.settings.tabs.openchronicle}
        description={screenMemoryText.webDescription}
      >
        <WebModeBanner />
        <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/60 p-4 text-sm text-zinc-400">
          {screenMemoryText.webBody}
        </div>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title={t.settings.tabs.openchronicle}
      description={screenMemoryText.pageDescription}
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {statusItems.map((item) => (
          <div key={item.label} className={`rounded-lg border px-3 py-2 ${toneClass[item.tone]}`}>
            <div className="text-[11px] opacity-75">{item.label}</div>
            <div className="text-sm font-medium mt-0.5">{item.value}</div>
          </div>
        ))}
      </div>

      <SettingsSection title={screenMemoryText.captureSection.title}>
        <ProviderHeading
          icon={<Server className="w-4 h-4" />}
          title={screenMemoryText.captureSection.openchronicleTitle}
          description={screenMemoryText.captureSection.openchronicleDescription}
          provider={openchronicleProvider}
          fallbackKind="daemon"
        />
        <OpenchronicleSettings embedded onInstalledChange={refreshActivityContext} />
        {/* 会前提醒放在显眼处（真机反馈：藏在默认折叠的诊断区里找不到） */}
        {tauri && <MeetingCalendarReminderToggle />}
      </SettingsSection>

      <SettingsDetails
        title={screenMemoryText.diagnostics.title}
        description={screenMemoryText.diagnostics.description}
        actions={(
          <button
            onClick={refreshActivityContext}
            disabled={contextLoading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-700 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${contextLoading ? 'animate-spin' : ''}`} />
            {screenMemoryText.refresh}
          </button>
        )}
      >
        <div className="space-y-4">
          <ProviderHeading
            icon={<Sparkles className="w-4 h-4" />}
            title={screenMemoryText.diagnostics.activityTitle}
            description={screenMemoryText.diagnostics.activityDescription}
          />
          <ActivityContextPreviewPanel
            context={activityContext}
            degraded={contextFailed ? screenMemoryText.activityContext.degradedMessage : null}
          />

          <ProviderHeading
            icon={tauri ? <Monitor className="w-4 h-4" /> : <Globe2 className="w-4 h-4" />}
            title={screenMemoryText.diagnostics.nativeDesktopTitle}
            description={screenMemoryText.diagnostics.nativeDesktopDescription}
            provider={nativeDesktopProvider}
            fallbackKind="bundled"
          />
          {tauri ? (
            <div className="h-[460px] rounded-lg border border-zinc-700/60 overflow-hidden bg-zinc-900">
              <NativeDesktopSection />
            </div>
          ) : (
            <NativeDesktopUnavailable />
          )}
        </div>
      </SettingsDetails>
    </SettingsPage>
  );
};
