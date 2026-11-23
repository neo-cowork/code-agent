import React from 'react';
import type { ModelProviderProtocol, ModelProviderSettings } from '@shared/contract';
import { isProviderImageIcon, normalizeProviderIcon } from '@shared/modelRuntime';
import { Toggle } from '../../../primitives';
import { useI18n } from '../../../../hooks/useI18n';
import { useProviderIconImageSource } from '../../../../utils/providerIconAssets';
import { getProtocolLabel } from './ModelSettings.helpers';

export function ProviderSettingsHeader({ title, providerConfig, protocol, baseUrl, needsApiKey, hasApiKey, onEnabledChange }: {
  title: string;
  providerConfig?: ModelProviderSettings;
  protocol: ModelProviderProtocol;
  baseUrl: string;
  needsApiKey: boolean;
  hasApiKey: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const { t } = useI18n();
  const text = t.settings.model.header;
  const icon = normalizeProviderIcon(providerConfig?.icon) || title.slice(0, 1).toUpperCase();
  const image = isProviderImageIcon(icon);
  const imageSource = useProviderIconImageSource(icon);
  const source = providerConfig?.apiKeySource;
  const keyLabel = !needsApiKey ? text.noApiKey : !hasApiKey ? text.waitingApiKey
    : source === 'saved' ? text.apiKeySaved : source === 'account' ? text.apiKeyAccount
      : source === 'environment' ? text.apiKeyEnvironment
        : providerConfig?.apiKey ? text.apiKeyUnsaved : text.apiKeyAvailable;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 text-base font-bold text-zinc-200">
          {image ? (imageSource ? <img src={imageSource} alt="" className="h-full w-full rounded-lg object-cover" /> : title.slice(0, 1).toUpperCase()) : icon}
        </span>
        <div>
          <h4 className="text-base font-semibold text-zinc-100">{title}</h4>
          <p className="mt-0.5 max-w-[420px] truncate text-xs text-zinc-500" title={baseUrl}>
            {getProtocolLabel(protocol, t.settings.model.helpers)} · {baseUrl || text.unsetAddress}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-4">
        <span data-model-key-status className={`text-xs ${hasApiKey ? 'text-badge-success' : 'text-badge-warning'}`}>{keyLabel}</span>
        <label className="flex items-center gap-2 text-xs text-zinc-400" title={text.selectableTitle}>
          <span>{text.selectableLabel}</span>
          <Toggle checked={providerConfig?.enabled !== false} onChange={onEnabledChange} aria-label={text.selectableAriaLabel} />
        </label>
      </div>
    </div>
  );
}
