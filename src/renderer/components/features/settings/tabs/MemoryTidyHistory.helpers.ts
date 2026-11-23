// ============================================================================
// MemoryTidyHistory.helpers —— 「最近整理」纯函数（N-MEM-CONSOLIDATION-HISTORY-UNDO）
// 独立成档同 MemoryEntriesManager.helpers 先例：组件与测试共用同一份组句逻辑，
// 组件文件只保留渲染（导出有生产消费方，knip 生产档不视为 dead export）。
// ============================================================================

import type {
  MemoryTidyPreviewView,
  MemoryTidyRunView,
} from '@shared/contract/memory';
import { formatMemoryEntryUpdatedAt } from './MemoryEntriesManager';
import { zh } from '../../../../i18n/zh';

export type MemoryTidyCopy = typeof zh.settings.memoryTidy;

/** 一次整理收起的来源卡总数（合并来源 + 冲突降级）。 */
function tidyPutAwayCount(run: MemoryTidyRunView): number {
  return run.merges.reduce((count, merge) => count + merge.sources.length, 0) + run.conflicts.length;
}

/** 行首一句人话摘要（内部 reason 字符串不外显）。 */
export function buildTidyRunSummary(run: MemoryTidyRunView, copy: MemoryTidyCopy): string {
  const changed = run.outcome === 'applied' && (run.mergeCount > 0 || run.conflictCount > 0);
  if (!changed) {
    return run.outcome === 'failed' || run.outcome === 'pending'
      ? copy.summaryFailed
      : copy.summaryNoChange;
  }
  const parts: string[] = [];
  if (run.mergeCount > 0) {
    parts.push(copy.summaryMerged
      .replace('{groups}', String(run.mergeCount))
      .replace('{cards}', String(tidyPutAwayCount(run) - run.conflictCount)));
  }
  if (run.conflictCount > 0) {
    parts.push((run.mergeCount > 0 ? copy.summaryConflictSuffix : copy.summaryConflictOnly)
      .replace('{count}', String(run.conflictCount)));
  }
  return parts.join('');
}

/** 开关未开启时的预告句（最近一次检查会改什么 / 暂时不会改什么）。 */
export function buildTidyPreviewSentence(
  preview: MemoryTidyPreviewView | null,
  copy: MemoryTidyCopy,
  labels: typeof zh.settings.memory.relativeDate,
  locale: string,
  now = Date.now(),
): string {
  if (!preview) return copy.previewMissing;
  const date = formatMemoryEntryUpdatedAt(preview.at, now, labels, locale);
  const intro = copy.previewIntro.replace('{date}', date);
  const mergeCount = preview.merges.length;
  const sourceCount = preview.merges.reduce((count, merge) => count + merge.sources.length, 0);
  if (preview.wouldChangeNothing || (mergeCount === 0 && preview.conflicts.length === 0)) {
    return `${intro} ${copy.previewNothing}`;
  }
  let sentence = `${intro} ${copy.previewWouldChange
    .replace('{groups}', String(mergeCount))
    .replace('{cards}', String(sourceCount))}`;
  if (preview.conflicts.length > 0) {
    sentence += copy.previewConflictSuffix.replace('{count}', String(preview.conflicts.length));
  }
  return sentence;
}
