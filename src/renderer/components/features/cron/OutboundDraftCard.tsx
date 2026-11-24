import { useState } from 'react';
import type { OutboundDraftInboxItem } from '@shared/contract/pendingApproval';
import { useI18n } from '../../../hooks/useI18n';
import { toast } from '../../../hooks/useToast';
import { sessionAutomationClient } from '../../../services/sessionAutomationClient';
import { getDisplaySessionTitle } from '../../../utils/sessionPresentation';
import { Button } from '../../primitives/Button';

export function OutboundDraftCard({ draft, onChange }: { draft: OutboundDraftInboxItem; onChange: () => void }) {
  const { t, language } = useI18n();
  const copy = t.cronCenter.outboundDraft;
  const [busy, setBusy] = useState(false);

  const decide = async (decision: 'send' | 'discard') => {
    setBusy(true);
    try {
      const code = await sessionAutomationClient.resolveOutboundDraft(draft.id, decision, draft.revision);
      toast.info(copy.outcomes[code]);
    } catch {
      toast.error(copy.actionFailed);
    } finally {
      onChange();
      setBusy(false);
    }
  };

  return (
    <article className="min-w-0 space-y-2 rounded-lg border border-zinc-700 bg-zinc-950/50 p-3" data-testid="outbound-draft">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium text-zinc-200">{copy.title}</h3>
        <div className="flex gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void decide('send')}>{copy.send}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void decide('discard')}>{copy.discard}</Button>
        </div>
      </header>
      {draft.scheduledTaskName && (
        <p className="break-words text-xs text-zinc-400">{getDisplaySessionTitle(draft.scheduledTaskName, language)}</p>
      )}
      <dl className="break-words text-xs text-zinc-200">
        {[
          [copy.to, draft.to.join(', ')],
          [copy.cc, draft.cc.join(', ')],
          [copy.bcc, draft.bcc.join(', ')],
          [copy.subject, draft.subject],
          [copy.attachments, draft.attachmentNames.join(', ')],
        ].filter(([, value]) => value).map(([label, value]) => (
          <div key={label} className="flex gap-2">
            <dt className="shrink-0 text-zinc-400">{label}</dt>
            <dd className="min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
      {draft.body && (
        <div tabIndex={0} role="region" aria-label={copy.body} className="max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs text-zinc-200">
          {draft.body}
        </div>
      )}
      {draft.needsReconfirm && (
        <p role="status" className="text-xs text-badge-warning">{copy.reconfirm}</p>
      )}
    </article>
  );
}
