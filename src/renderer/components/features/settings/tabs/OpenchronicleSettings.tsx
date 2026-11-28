// ============================================================================
// OpenchronicleSettings — 「屏幕记忆」设置 tab
// 控制外部 OpenChronicle 配套程序的开关 + 隐私名单。
// 状态没回来前、以及宿主报告没装（status.installed === false）时，开关/勾选/名单全部锁住，
// 只显示一句未安装说明；宿主原始报错只进日志，界面上换成语言包里的一句话。
// ============================================================================

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Eye, EyeOff, AlertTriangle, Info, RefreshCw } from 'lucide-react';
import { IPC_DOMAINS } from '@shared/ipc';
import { createLogger } from '../../../../utils/logger';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import ipcService from '../../../../services/ipcService';
import { useI18n } from '../../../../hooks/useI18n';
import { zh } from '../../../../i18n/zh';
import { interpolatePlural } from '../../../../i18n/interpolate';
import type {
  OpenchronicleSettings as OcSettings,
  OpenchronicleStatus,
} from '../../../../../shared/contract/openchronicle';
import { DEFAULT_OPENCHRONICLE_SETTINGS } from '../../../../../shared/contract/openchronicle';
import { Toggle } from '../../../primitives/Toggle';

const logger = createLogger('OpenchronicleSettings');

type OpenchronicleSettingsText = typeof zh.settings.openchronicle;

const STATE_DOT: Record<OpenchronicleStatus['state'], string> = {
  running: 'bg-green-500',
  starting: 'bg-yellow-500',
  stopping: 'bg-yellow-500',
  stopped: 'bg-zinc-500',
  error: 'bg-red-500',
};

function getOpenchronicleStateLabel(
  state: OpenchronicleStatus['state'],
  labels: OpenchronicleSettingsText['stateLabels'] = zh.settings.openchronicle.stateLabels,
): { dot: string; text: string } {
  return {
    dot: STATE_DOT[state],
    text: labels[state],
  };
}

interface OpenchronicleSettingsProps {
  embedded?: boolean;
  /** 装没装在本组件轮询里翻转时通知上层（屏幕记忆页据此重读顶部状态格）。 */
  onInstalledChange?: () => void;
}

interface OpenchronicleToggleSwitchProps {
  checked: boolean;
  busy?: boolean;
  onToggle: () => void;
}

export const OpenchronicleToggleSwitch: React.FC<OpenchronicleToggleSwitchProps> = ({
  checked,
  busy = false,
  onToggle,
}) => {
  const { t } = useI18n();
  return (
    <Toggle
      size="md"
      checked={checked}
      disabled={busy}
      onChange={() => onToggle()}
      aria-label={t.settings.openchronicle.control.enableScreenMemory}
    />
  );
};

export const OpenchronicleSettings: React.FC<OpenchronicleSettingsProps> = ({ embedded = false, onInstalledChange }) => {
  const { t } = useI18n();
  const openchronicleText = t.settings.openchronicle;
  const [settings, setSettings] = useState<OcSettings>(DEFAULT_OPENCHRONICLE_SETTINGS);
  const [status, setStatus] = useState<OpenchronicleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusReadFailed, setStatusReadFailed] = useState(false);

  // 没拿到状态前不知道装没装，同样锁住；宿主明确说没装时显示未安装说明。
  const notInstalled = status?.installed === false;
  const locked = status === null || notInstalled;
  // 关掉开关后宿主残留的上一次失败原因不再提示（关闭成功时宿主不清 lastError）。
  const rawError = notInstalled ? null : error ?? (settings.enabled ? status?.lastError : undefined) ?? null;

  useEffect(() => {
    if (rawError) logger.warn('OpenChronicle reported a problem', { detail: rawError });
  }, [rawError]);

  const lastInstalled = useRef<boolean | null>(null);
  const installed = status?.installed;
  useEffect(() => {
    if (installed === undefined) return;
    if (lastInstalled.current !== null && lastInstalled.current !== installed) onInstalledChange?.();
    lastInstalled.current = installed;
  }, [installed, onInstalledChange]);

  const refresh = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([
        ipcService.invokeDomain<OcSettings>(IPC_DOMAINS.OPENCHRONICLE, 'getSettings'),
        ipcService.invokeDomain<OpenchronicleStatus>(IPC_DOMAINS.OPENCHRONICLE, 'getStatus'),
      ]);
      if (s) setSettings(s);
      if (st) setStatus(st);
      setStatusReadFailed(false);
    } catch (e) {
      logger.error('refresh failed', e);
      setStatusReadFailed(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const handleToggle = async (next: boolean) => {
    if (locked) return;
    setBusy(true);
    setError(null);
    try {
      const result = await ipcService.invokeDomain<{ ok: boolean; error?: string }>(
        IPC_DOMAINS.OPENCHRONICLE,
        'setEnabled',
        { enabled: next },
      );
      if (!result?.ok) {
        setError(result?.error ?? openchronicleText.operationFailed);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const updateSettings = async (patch: Partial<OcSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await ipcService.invokeDomain(IPC_DOMAINS.OPENCHRONICLE, 'updateSettings', next);
  };

  if (isWebMode()) {
    return (
      <div className={embedded ? 'space-y-3' : 'p-6'}>
        <WebModeBanner />
        <p className="text-sm text-zinc-400 mt-4">
          {openchronicleText.webUnavailable}
        </p>
      </div>
    );
  }

  const stateUi = notInstalled
    ? { dot: STATE_DOT.stopped, text: openchronicleText.status.notInstalled }
    : getOpenchronicleStateLabel(status?.state ?? 'stopped', openchronicleText.stateLabels);

  return (
    <div className={embedded ? 'space-y-4' : 'p-6 space-y-6 max-w-3xl'}>
      {/* 标题 */}
      {!embedded && (
      <header>
        <h2 className="text-xl font-semibold flex items-center gap-2">
          {settings.enabled ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
          {t.settings.tabs.openchronicle}
        </h2>
        <p className="text-sm text-zinc-400 mt-1">
          {openchronicleText.header.introPrefix}<code className="text-xs bg-zinc-800 px-1 rounded">OpenChronicle</code>{openchronicleText.header.introMiddle}
          {openchronicleText.header.introSuffix}
        </p>
        <p className="text-xs text-badge-warning mt-2 flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          {openchronicleText.header.warning}
        </p>
      </header>
      )}

      {/* 没装配套程序：一句人话说明，下面的控件全部锁住 */}
      {notInstalled && (
        <div className="flex items-start gap-2 rounded-lg border border-zinc-700/60 bg-zinc-900/60 p-3 text-sm text-zinc-300">
          <Info className="w-4 h-4 mt-0.5 shrink-0 text-zinc-400" />
          <p>{openchronicleText.notInstalled}</p>
        </div>
      )}

      {/* 主开关 */}
      <section className="border border-zinc-700 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">{openchronicleText.control.enableScreenMemory}</div>
            <div className="text-xs text-zinc-400 mt-0.5">
              {openchronicleText.control.description}
            </div>
          </div>
          <OpenchronicleToggleSwitch
            checked={settings.enabled}
            busy={busy || locked}
            onToggle={() => handleToggle(!settings.enabled)}
          />
        </div>

        <div className="mt-4 pt-4 border-t border-zinc-700 grid grid-cols-2 gap-3 text-xs">
          <div>
            <div className="text-zinc-400">{openchronicleText.status.state}</div>
            <div className="flex items-center gap-1.5 mt-1">
              <span className={`w-2 h-2 rounded-full ${stateUi.dot}`} />
              <span>{stateUi.text}</span>
            </div>
          </div>
          <div>
            <div className="text-zinc-400">{openchronicleText.status.connection}</div>
            <div className="mt-1">
              <span className={status?.mcpHealthy ? 'text-badge-success' : 'text-zinc-500'}>
                {status?.mcpHealthy ? openchronicleText.status.connected : openchronicleText.status.disconnected}
              </span>
            </div>
          </div>
          <div>
            <div className="text-zinc-400">{openchronicleText.status.pending}</div>
            <div className="mt-1">{interpolatePlural(openchronicleText.status.pendingCount, status?.bufferFiles ?? 0)}</div>
          </div>
          <div>
            <div className="text-zinc-400">{openchronicleText.status.kept}</div>
            <div className="mt-1">{interpolatePlural(openchronicleText.status.keptCount, status?.memoryEntries ?? 0)}</div>
          </div>
        </div>

        {(rawError || (status === null && statusReadFailed)) && (
          <div className="mt-3 p-2 bg-red-900/30 border border-red-700 rounded text-xs text-badge-danger">
            {rawError ? openchronicleText.runError : openchronicleText.statusUnavailable}
          </div>
        )}

        <div className="mt-3 flex gap-2">
          <button
            onClick={refresh}
            className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" /> {openchronicleText.refresh}
          </button>
          {status?.installed && (
            <span className="text-xs text-zinc-500">
              {openchronicleText.status.dataDirPrefix}<code className="bg-zinc-800 px-1 rounded">~/.openchronicle/memory/</code>
            </span>
          )}
        </div>
      </section>

      {/* 上下文注入开关 */}
      <section className="border border-zinc-700 rounded-lg p-4">
        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <div className="font-medium">{openchronicleText.autoInject.title}</div>
            <div className="text-xs text-zinc-400 mt-0.5">
              {openchronicleText.autoInject.description}
            </div>
          </div>
          <input
            type="checkbox"
            checked={settings.autoInjectContext}
            onChange={(e) => updateSettings({ autoInjectContext: e.target.checked })}
            disabled={locked || !settings.enabled}
            className="w-4 h-4 disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </label>
      </section>

      {/* 不带进对话的应用和网站 */}
      <section className="border border-zinc-700 rounded-lg p-4">
        <div className="font-medium mb-2">{openchronicleText.blacklist.title}</div>
        <div className="text-xs text-zinc-400 mb-3">
          {openchronicleText.blacklist.description}
        </div>

        <div className="space-y-3">
          <div>
            <div className="text-xs text-zinc-300 mb-1">{openchronicleText.blacklist.appsLabel}</div>
            <textarea
              value={settings.blacklistApps.join('\n')}
              onChange={(e) =>
                updateSettings({ blacklistApps: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
              }
              disabled={locked || !settings.enabled}
              rows={4}
              aria-label={openchronicleText.blacklist.appsLabel}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs font-mono disabled:opacity-50 disabled:cursor-not-allowed"
              placeholder={openchronicleText.blacklist.appsPlaceholder}
            />
          </div>
          <div>
            <div className="text-xs text-zinc-300 mb-1">{openchronicleText.blacklist.urlPatternsLabel}</div>
            <textarea
              value={settings.blacklistUrlPatterns.join('\n')}
              onChange={(e) =>
                updateSettings({ blacklistUrlPatterns: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
              }
              disabled={locked || !settings.enabled}
              rows={4}
              aria-label={openchronicleText.blacklist.urlPatternsLabel}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs font-mono disabled:opacity-50 disabled:cursor-not-allowed"
              placeholder={openchronicleText.blacklist.urlPatternsPlaceholder}
            />
          </div>
        </div>
      </section>
    </div>
  );
};
