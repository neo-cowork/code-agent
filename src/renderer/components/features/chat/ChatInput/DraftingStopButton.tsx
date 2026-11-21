import { Loader2, Square } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { IconButton } from '../../../primitives';

interface DraftingStopButtonProps {
  isProcessing?: boolean;
  hasStoppableBackgroundWork?: boolean;
  hasContent: boolean;
  isStopping?: boolean;
  onStop?: () => void;
}

export function DraftingStopButton({
  isProcessing,
  hasStoppableBackgroundWork,
  hasContent,
  isStopping,
  onStop,
}: DraftingStopButtonProps) {
  const { t } = useI18n();
  if (!(isProcessing || hasStoppableBackgroundWork) || !hasContent) return null;

  const label = isStopping ? t.chatInput.stoppingAria : t.chatInput.stopAria;
  return (
    <IconButton
      type="button"
      size="sm"
      className="h-7 w-7 shrink-0"
      icon={isStopping ? <Loader2 className="animate-spin" /> : <Square className="fill-current" />}
      onClick={onStop}
      aria-label={label}
      title={label}
      data-testid="composer-stop-while-drafting"
    />
  );
}
