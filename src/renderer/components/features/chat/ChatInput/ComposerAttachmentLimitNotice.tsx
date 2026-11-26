import React from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button } from '../../../primitives/Button';
import { useComposerAttachmentLimitStore } from '../../../../stores/composerAttachmentLimitStore';

export const ComposerAttachmentLimitNotice: React.FC = () => {
  const { t } = useI18n();
  const notice = useComposerAttachmentLimitStore((s) => s.notice);
  const clear = useComposerAttachmentLimitStore((s) => s.clear);

  if (!notice) return null;

  const template = notice.kind === 'partial' ? t.chatInput.attachmentLimitReached : t.chatInput.attachmentLimitReachedNone;

  return (
    <div
      data-testid="composer-attachment-limit"
      role="alert"
      className="mb-2 flex items-center gap-2 rounded-lg border border-badge-warning/20 bg-amber-500/10 px-3 py-2"
    >
      <span className="min-w-0 flex-1 text-sm text-badge-warning">
        {template
          .replace('{added}', String(notice.added))
          .replace('{dropped}', String(notice.dropped))
          .replace('{max}', String(notice.max))}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={t.chatInput.rejectedUploadDismiss}
        data-testid="composer-attachment-limit-dismiss"
        onClick={clear}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
};
