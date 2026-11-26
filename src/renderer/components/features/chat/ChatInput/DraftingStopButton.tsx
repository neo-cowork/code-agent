import { Square } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { IconButton } from '../../../primitives';
import { StoppingButton } from './StoppingButton';

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

  if (isStopping) {
    return (
      <StoppingButton
        onStop={onStop}
        testId="composer-stop-while-drafting"
        className="composer-drafting-stop"
        title
      />
    );
  }

  const label = t.chatInput.stopAria;
  return (
    <IconButton
      type="button"
      size="sm"
      className="composer-drafting-stop h-7 w-7 shrink-0"
      icon={<Square className="fill-current" />}
      onClick={onStop}
      aria-label={label}
      title={label}
      data-testid="composer-stop-while-drafting"
    />
  );
}
