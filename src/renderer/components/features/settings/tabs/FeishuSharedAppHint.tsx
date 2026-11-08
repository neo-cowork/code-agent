import React from 'react';
import type { ChannelAccount } from '@shared/contract/channel';
import { useI18n } from '../../../../hooks/useI18n';

function showsFeishuSharedAppHint(account: ChannelAccount): boolean {
  if (account.type !== 'feishu' && account.type !== 'lark') return false;
  if (account.status !== 'connected') return false;
  return account.feishuSharedAppDetected === true;
}

/** Account-row warning when another local Neo process also holds a WebSocket connection for the same Feishu/Lark app. */
export function FeishuSharedAppHint({ account }: { account: ChannelAccount }): React.ReactElement | null {
  const { t } = useI18n();
  if (!showsFeishuSharedAppHint(account)) return null;
  return (
    <div className="mt-1 text-xs text-badge-warning" data-testid="feishu-shared-app-hint">
      {t.settings.channels.modal.feishuSharedAppWarning}
    </div>
  );
}
