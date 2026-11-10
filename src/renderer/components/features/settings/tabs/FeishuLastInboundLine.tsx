import React from 'react';
import type { ChannelAccount } from '@shared/contract/channel';
import { useI18n } from '../../../../hooks/useI18n';
import { formatDateTime } from '../../../../utils/formatDateTime';

/** Muted second line under "Connected": tells "nothing arrived" apart from "arrived but was filtered". */
export function FeishuLastInboundLine({ account }: { account: ChannelAccount }): React.ReactElement | null {
  const { t, language } = useI18n();
  if (account.type !== 'feishu' && account.type !== 'lark') return null;
  if (account.status !== 'connected') return null;
  const modal = t.settings.channels.modal;
  const text = account.lastInboundAt === undefined
    ? modal.feishuNoInboundYet
    : modal.feishuLastInbound.replace('{time}', formatDateTime(account.lastInboundAt, language));
  return (
    <div className="mt-1 text-xs text-zinc-500" data-testid="feishu-last-inbound">
      {text}
    </div>
  );
}
