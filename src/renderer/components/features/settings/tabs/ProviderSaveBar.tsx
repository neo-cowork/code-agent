import React from 'react';
import { Button } from '../../../primitives';
import { useI18n } from '../../../../hooks/useI18n';

export function ProviderSaveBar({
  dirty,
  apiKeyUnsaved,
  saving,
  disabled,
  disabledTitle,
  providerTitle,
  onSave,
}: {
  dirty: boolean;
  apiKeyUnsaved: boolean;
  saving: boolean;
  disabled: boolean;
  disabledTitle?: string;
  providerTitle: string;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const text = t.settings.model.header;
  return (
    <div
      data-testid="provider-save-bar"
      className="sticky bottom-0 z-10 flex flex-col gap-2 border-t border-zinc-800 bg-zinc-950 py-3"
    >
      {(dirty || apiKeyUnsaved) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {dirty && (
            <span className="inline-flex w-fit items-center rounded border border-badge-warning/30 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-badge-warning">
              {text.unsavedBadge}
            </span>
          )}
          {apiKeyUnsaved && (
            <span className="text-xs text-badge-warning">{text.apiKeyUnsaved}</span>
          )}
        </div>
      )}
      <Button
        disabled={disabled}
        title={disabledTitle}
        onClick={onSave}
        loading={saving}
        size="lg"
        variant="primary"
        className="w-full"
      >
        {saving ? t.common.saving : text.saveConfig}
      </Button>
      <span className="text-xs text-zinc-500">
        {text.saveHintPrefix}{providerTitle}{text.saveHintSuffix}
      </span>
    </div>
  );
}
