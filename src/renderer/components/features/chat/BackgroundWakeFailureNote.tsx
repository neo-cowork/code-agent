import React from 'react';
import type { MessageMetadata } from '@shared/contract';
import { useI18n } from '../../../hooks/useI18n';
import { useAgentTreeSnapshot } from '../../../hooks/useAgentTreeSnapshot';
import { languages } from '../../../i18n';
import { agentNodeLabel } from '../../../utils/agentRoleLabel';
import { containsCjk } from '../../../utils/containsCjk';
import { interpolate } from '../../../i18n/interpolate';

/** Persisted host prose stays unchanged in ZH; EN renders from structured metadata. */
export function BackgroundWakeFailureNote({
  detail,
  content,
  sessionId,
}: {
  detail: NonNullable<MessageMetadata['backgroundWakeFailed']>;
  content: string;
  sessionId?: string;
}) {
  const { t } = useI18n();
  const metadataTitle = detail.title?.trim();
  const usableMetadataTitle = metadataTitle && !(t === languages.en && containsCjk(metadataTitle))
    ? metadataTitle
    : undefined;
  const { snapshot } = useAgentTreeSnapshot(
    sessionId ?? null,
    Boolean(sessionId && t !== languages.zh && !usableMetadataTitle),
    true,
  );
  if (t === languages.zh && content) {
    return (
      <div className="px-3 py-1.5 text-xs text-zinc-500 italic" data-testid="background-wake-failure-note">
        {content}
      </div>
    );
  }
  const node = usableMetadataTitle
    ? undefined
    : snapshot?.nodes.find((candidate) => candidate.id === detail.taskId || candidate.backgroundAgentId === detail.taskId);
  const title = usableMetadataTitle
    ?? (node ? agentNodeLabel(node, t.agentRoleLabels) : t.agentRoleLabels.roles.background);
  return (
    <div className="px-3 py-1.5 text-xs text-zinc-500 italic" data-testid="background-wake-failure-note">
      {interpolate(t.backgroundPanel.wakeFailed, { title })}
    </div>
  );
}
