import { Sparkles, X } from 'lucide-react';
import { IconButton } from '../../../primitives/IconButton';
import { useI18n } from '../../../../hooks/useI18n';
import { useNeoWorkCardStore } from '../../../../stores/neoWorkCardStore';
import { useSessionStore } from '../../../../stores/sessionStore';

/** 输入框上方的续接标记：只在目标会话就是当前会话时出现，× 清掉目标。 */
export function NeoContinuationChip() {
  const { t } = useI18n();
  const target = useNeoWorkCardStore((state) => state.continuationTarget);
  const setTarget = useNeoWorkCardStore((state) => state.setContinuationTarget);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  if (target?.conversationId !== currentSessionId) return null;
  return (
    <div
      data-testid="neo-continuation-chip"
      className="mt-3 inline-flex max-w-full items-center gap-1 rounded-full border border-badge-success/30 bg-emerald-500/10 py-0.5 pl-2 pr-0.5 text-xs text-badge-success"
    >
      <Sparkles className="h-3 w-3 shrink-0" aria-hidden />
      <span className="max-w-[220px] truncate">{t.neoContinuation.continuePrefix}{target.title}</span>
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        aria-label={t.neoContinuation.removeAria}
        icon={<X aria-hidden />}
        onClick={() => setTarget(null)}
        className="h-5 w-5 shrink-0"
      />
    </div>
  );
}
