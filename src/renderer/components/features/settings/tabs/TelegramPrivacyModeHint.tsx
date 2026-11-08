import React from 'react';
import type { ChannelAccount } from '@shared/contract/channel';
import { useI18n } from '../../../../hooks/useI18n';
import { ChannelAccountWarningStrip } from './ChannelAccountWarningStrip';

function showsTelegramPrivacyModeHint(account: ChannelAccount): boolean {
  if (account.type !== 'telegram' || account.config.type !== 'telegram') return false;
  // The warning describes a live connection's getMe result; a stale value survives
  // status changes (disconnect/error/connecting) and restarts, so only surface it
  // while connected — the next successful connect writes a fresh value anyway.
  if (account.status !== 'connected') return false;
  return account.config.groupAccessMode === 'all_members'
    && account.telegramCanReadAllGroupMessages === false;
}

/** Account-row warning. Unknown (never connected), a true getMe result and any non-connected status render nothing. */
export function TelegramPrivacyModeHint({ account }: { account: ChannelAccount }): React.ReactElement | null {
  const { t } = useI18n();
  if (!showsTelegramPrivacyModeHint(account)) return null;
  return (
    <ChannelAccountWarningStrip
      body={t.settings.channels.modal.telegramPrivacyModeWarning}
      title={t.settings.channels.modal.telegramPrivacyModeTitle}
      data-testid="telegram-privacy-mode-hint"
    />
  );
}

/** Compact status-cell label paired with the full instructions below the account row. */
export function TelegramPrivacyModeBadge({ account }: { account: ChannelAccount }): React.ReactElement | null {
  const { t } = useI18n();
  if (!showsTelegramPrivacyModeHint(account)) return null;
  return (
    <span className="mt-1 inline-flex whitespace-nowrap rounded border border-badge-warning bg-badge-warning px-1.5 py-0.5 text-[10px] leading-4 text-badge-warning">
      {t.settings.channels.modal.telegramPrivacyModeBadge}
    </span>
  );
}

/** One-line prerequisite under the group-access select, only while all_members is chosen. */
export function TelegramGroupAccessPrerequisite({
  mode,
}: {
  mode: 'allowlist' | 'all_members';
}): React.ReactElement | null {
  const { t } = useI18n();
  if (mode !== 'all_members') return null;
  return (
    <p className="mt-1 text-xs text-zinc-500" data-testid="telegram-privacy-mode-prerequisite">
      {t.settings.channels.modal.groupAccessModePrivacyPrerequisite}
    </p>
  );
}
