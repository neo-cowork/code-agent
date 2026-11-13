import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { useAgentTreeSnapshot } from '../../../hooks/useAgentTreeSnapshot';
import { agentNodeLabel } from '../../../utils/agentRoleLabel';
import { interpolate } from '../../../i18n/interpolate';

/** Persisted host prose is model context; user copy follows the current UI locale. */
export function BackgroundWakeFailureNote({ taskId, sessionId }: { taskId: string; sessionId?: string }) {
  const { t } = useI18n();
  const { snapshot } = useAgentTreeSnapshot(sessionId ?? null, Boolean(sessionId), true);
  const node = snapshot?.nodes.find((candidate) => candidate.id === taskId || candidate.backgroundAgentId === taskId);
  const title = node ? agentNodeLabel(node, t.agentRoleLabels) : t.agentRoleLabels.roles.background;
  return <div className="px-3 py-1.5 text-xs text-zinc-500 italic" data-testid="background-wake-failure-note">
    {interpolate(t.backgroundPanel.wakeFailed, { title })}
  </div>;
}
