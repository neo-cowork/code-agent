import React, { useState } from 'react';
import { Brain } from 'lucide-react';
import type { TurnQualityMemoryBlockType, TurnQualityMemoryItem, TurnQualitySummary } from '@shared/contract/turnQuality';
import { Button } from '../../primitives';
import { useI18n } from '../../../hooks/useI18n';
import { unescapeHtmlEntities } from '../../../utils/htmlEntities';

// 白名单：memory_index 是每轮常驻的 MemoryRead 目录（无 items），不代表这轮用了记忆。
const USED_MEMORY_BLOCK_TYPES = new Set<TurnQualityMemoryBlockType>(['seed-memory', 'user-memory', 'user-directives']);

/** 本轮实际注入的记忆条目（按 entryId 去重）；mode=off 或无注入块时返回 null。只认真正把记忆内容放进提示词的块；常驻目录 memory_index、memory_hint、recent_conversations、failure_journal 都不算「本条回复参考了记忆」。 */
function usedMemory(summary: TurnQualitySummary): { items: TurnQualityMemoryItem[] } | null {
  if (summary.memory.mode === 'off') return null;
  const injected = summary.memory.blocks.filter((block) => block.injected && block.count > 0 && USED_MEMORY_BLOCK_TYPES.has(block.blockType));
  if (injected.length === 0) return null;
  const seen = new Set<string>();
  const items = injected.flatMap((block) => block.items || []).filter((item) => {
    if (seen.has(item.entryId)) return false;
    seen.add(item.entryId);
    return true;
  });
  return { items };
}

export function hasUsedMemory(summary: TurnQualitySummary): boolean {
  return usedMemory(summary) !== null;
}

export const MemorySourceChip: React.FC<{ summary: TurnQualitySummary }> = ({ summary }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const used = usedMemory(summary);
  if (!used) return null;
  const { items } = used;
  const label = items.length > 0
    ? t.memorySource.usedCount.replace('{count}', String(items.length))
    : t.memorySource.usedGeneric;
  return (
    <div className="flex min-w-0 max-w-full flex-col items-start gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="!px-1.5 !py-0.5 text-[10px] text-zinc-500"
        leftIcon={<Brain className="h-3 w-3" />}
        aria-expanded={open}
        title={t.memorySource.toggleTitle}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </Button>
      {open && (
        <div className="min-w-0 max-w-full shrink-0 rounded-md border border-border-muted bg-surface-subtle px-2 py-1.5 text-[11px] text-zinc-400">
          {items.length > 0 && (
            <ul className="mb-1 space-y-1">
              {items.map((item) => (
                <li key={item.entryId}>
                  <div className="text-zinc-300">{unescapeHtmlEntities(item.title)}</div>
                  {item.preview && (
                    <div className="truncate text-zinc-500">{unescapeHtmlEntities(item.preview)}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="text-zinc-500">{t.memorySource.hint}</div>
        </div>
      )}
    </div>
  );
};
