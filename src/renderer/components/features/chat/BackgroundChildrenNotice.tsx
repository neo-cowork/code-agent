import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { useLiveBackgroundAgentCount } from '../../../hooks/useLiveBackgroundAgentCount';
import { interpolatePlural } from '../../../i18n/interpolate';

export const BackgroundChildrenNotice: React.FC<{ sessionId?: string }> = ({ sessionId }) => {
  const { t } = useI18n();
  const count = useLiveBackgroundAgentCount(sessionId);
  if (!count) return null;
  return <p data-testid="background-children-notice" className="mt-1 pl-[22px] text-[13px] text-text-secondary">
    {interpolatePlural(t.agentError.backgroundContinuing, count)}
  </p>;
};
