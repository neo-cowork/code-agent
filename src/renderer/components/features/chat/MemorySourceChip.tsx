import React, { useState } from 'react';
import { Brain } from 'lucide-react';
import type { TurnQualityMemoryBlockType, TurnQualityMemoryItem, TurnQualitySummary } from '@shared/contract/turnQuality';
import { Button } from '../../primitives';
import { useI18n } from '../../../hooks/useI18n';
import { unescapeHtmlEntities } from '../../../utils/htmlEntities';

// 只计打包器按条目放进提示词的记忆。user-directives 每轮不带 query、全量注入；
// 没有 items 的 database-seed 回退也没有条目粒度。这两类都不算「本条回复参考了记忆」。
// memory_index 等常驻目录不在白名单里，同样排除。
const USED_MEMORY_BLOCK_TYPES = new Set<TurnQualityMemoryBlockType>(['seed-memory', 'user-memory']);

/** 本轮按条目注入的记忆（按 entryId 去重）。无此类条目时返回 null，标签只用条数形式。 */
function usedMemory(summary: TurnQualitySummary): { items: TurnQualityMemoryItem[] } | null {
  if (summary.memory.mode === 'off') return null;
  const injected = summary.memory.blocks.filter((block) => (
    block.injected
    && block.count > 0
    && USED_MEMORY_BLOCK_TYPES.has(block.blockType)
    && (block.items?.length ?? 0) > 0
  ));
  if (injected.length === 0) return null;
  const seen = new Set<string>();
  const items = injected.flatMap((block) => block.items || []).filter((item) => {
    if (seen.has(item.entryId)) return false;
    seen.add(item.entryId);
    return true;
  });
  if (items.length === 0) return null;
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
  const label = t.memorySource.usedCount.replace('{count}', String(items.length));
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
