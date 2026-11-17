import React from 'react';
import type { AssistantFeedbackState } from '../../../utils/sendWithImmediateAssistantFeedback';
import { StreamingIndicator } from './StreamingIndicator';

/** Send/queue phases keep their own copy (and slow-start notice); activation onward shows preparation. */
export function AssistantFeedbackIndicator({ feedback }: { feedback: AssistantFeedbackState }) {
  return (
    <StreamingIndicator
      startTime={feedback.startedAt}
      preparationPhase={feedback.phase === 'queued' || feedback.phase === 'submitting' ? feedback.phase : 'preparing'}
    />
  );
}
