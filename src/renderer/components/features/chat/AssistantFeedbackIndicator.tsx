import React from 'react';
import type { AssistantFeedbackState } from '../../../utils/sendWithImmediateAssistantFeedback';
import { StreamingIndicator } from './StreamingIndicator';

/** A queued message is not yet running; all other pre-reply phases show preparation. */
export function AssistantFeedbackIndicator({ feedback }: { feedback: AssistantFeedbackState }) {
  return (
    <StreamingIndicator
      startTime={feedback.startedAt}
      preparationPhase={feedback.phase === 'queued' ? 'queued' : 'preparing'}
    />
  );
}
