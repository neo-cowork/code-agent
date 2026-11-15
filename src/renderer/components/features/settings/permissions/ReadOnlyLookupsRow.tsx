import React, { useEffect, useState } from 'react';
import type { AppSettings } from '@shared/contract';
import { Toggle } from '../../../primitives/Toggle';
import { useI18n } from '../../../../hooks/useI18n';
import { toast } from '../../../../hooks/useToast';
import { SettingsSection } from '../SettingsLayout';

interface ReadOnlyLookupsRowProps {
  enabled: boolean;
  disabled: boolean;
  onSave: (patch: Partial<AppSettings['permissions']>) => Promise<void>;
}

export function ReadOnlyLookupsRow({ enabled, disabled, onSave }: ReadOnlyLookupsRowProps) {
  const { t } = useI18n();
  const text = t.settings.general.permissions.readOnlyLookups;
  const [checked, setChecked] = useState(enabled);
  const [saving, setSaving] = useState(false);
  useEffect(() => setChecked(enabled), [enabled]);

  const save = async (next: boolean) => {
    const previous = checked;
    setChecked(next);
    setSaving(true);
    try {
      await onSave({ readOnlyProbePlan: next });
      toast.success(next ? text.savedOn : text.savedOff);
    } catch {
      // The shared settings persistence callback shows the existing error toast.
      setChecked(previous);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title={text.title}
      description={text.description}
      actions={(
        <Toggle
          checked={checked}
          disabled={disabled || saving}
          onChange={(next) => void save(next)}
          aria-label={text.title}
        />
      )}
    >
      {null}
    </SettingsSection>
  );
}
