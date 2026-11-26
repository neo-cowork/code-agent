import { Loader2 } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button } from '../../../primitives';

interface StoppingButtonProps {
  onStop?: () => void;
  testId: string;
  className?: string;
  title?: boolean;
}

export function StoppingButton({ onStop, testId, className = '', title }: StoppingButtonProps) {
  const { t } = useI18n();
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className={`h-7 [&]:rounded-full ${className}`}
      leftIcon={<Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
      onClick={onStop}
      aria-label={t.chatInput.stoppingAria}
      title={title ? t.chatInput.stoppingAria : undefined}
      data-testid={testId}
    >
      {t.chatInput.stoppingLabel}
    </Button>
  );
}
