import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface ChannelAccountWarningStripProps {
  body: string;
  title?: string;
  'data-testid'?: string;
}

export function ChannelAccountWarningStrip({
  body,
  title,
  'data-testid': testId,
}: ChannelAccountWarningStripProps): React.ReactElement {
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-badge-warning bg-badge-warning px-3 py-2 text-xs leading-5 text-badge-warning"
      data-testid={testId}
      role="status"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        {title && <div className="font-medium">{title}</div>}
        <div>{body}</div>
      </div>
    </div>
  );
}
