import React from 'react';
import { Button } from '../../../primitives/Button';
import { useI18n } from '../../../../hooks/useI18n';

const EMPTY_NAMES: string[] = [];

function basenameOnly(name: string): string {
  const trimmed = name.trim();
  return trimmed.split(/[\\/]/).pop()?.trim() || trimmed;
}

/** Offer above the empty composer. Copy stays neutral about send outcome and free of internal paths/terms. */
export function UnsentDraftNotice({
  preview,
  attachmentNames = EMPTY_NAMES,
  droppedNames = EMPTY_NAMES,
  onPutBack,
  onDiscard,
}: {
  preview: string;
  attachmentNames?: string[];
  droppedNames?: string[];
  onPutBack: () => void;
  onDiscard: () => void;
}): React.ReactElement {
  const { t } = useI18n();
  const safeAttachments = attachmentNames.map(basenameOnly).filter(Boolean);
  const safeDropped = droppedNames.map(basenameOnly).filter(Boolean);
  const hasText = preview.trim().length > 0;
  const hasAttachments = safeAttachments.length > 0;
  const hasDropped = safeDropped.length > 0;
  const canPutBack = hasText || hasAttachments;

  const sep = t.chatInput.unsentDraftNameSeparator;
  const joinedAttachments = safeAttachments.join(sep);
  const joinedDropped = safeDropped.join(sep);

  let base = '';
  if (hasText && hasAttachments) {
    const tpl = safeAttachments.length === 1
      ? t.chatInput.unsentDraftNoticeWithOneAttachment
      : t.chatInput.unsentDraftNoticeWithAttachments;
    base = tpl
      .replace('{preview}', () => preview)
      .replace('{count}', () => String(safeAttachments.length))
      .replace('{names}', () => joinedAttachments);
  } else if (hasText) {
    base = t.chatInput.unsentDraftNotice.replace('{preview}', () => preview);
  } else if (hasAttachments) {
    const tpl = safeAttachments.length === 1
      ? t.chatInput.unsentDraftOneAttachmentOnly
      : t.chatInput.unsentDraftAttachmentsOnly;
    base = tpl
      .replace('{count}', () => String(safeAttachments.length))
      .replace('{names}', () => joinedAttachments);
  }

  let message = base;
  if (hasDropped) {
    if (base) {
      message = `${base}${t.chatInput.unsentDraftDroppedSuffix.replace('{dropped}', () => joinedDropped)}`;
    } else {
      const tpl = safeDropped.length === 1
        ? t.chatInput.unsentDraftOneDroppedOnly
        : t.chatInput.unsentDraftDroppedOnly;
      message = tpl.replace('{dropped}', () => joinedDropped);
    }
  }

  return (
    <div
      data-testid="unsent-draft-notice"
      className="mb-2 flex items-center gap-2 rounded-xl border border-border-default bg-surface-subtle px-3 py-2"
    >
      <p className="min-w-0 flex-1 line-clamp-2 break-words text-sm text-text-primary">{message}</p>
      {canPutBack && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="unsent-draft-put-back"
          onClick={onPutBack}
        >
          {t.chatInput.unsentDraftPutBack}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="unsent-draft-discard"
        onClick={onDiscard}
      >
        {t.chatInput.unsentDraftDiscard}
      </Button>
    </div>
  );
}
