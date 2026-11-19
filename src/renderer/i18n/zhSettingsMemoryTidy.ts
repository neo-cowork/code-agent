// ============================================================================
// Settings namespace translations (zh/MemoryTidy) — 设置页「最近整理」
// （N-MEM-CONSOLIDATION-HISTORY-UNDO；zhSettingsWork 已贴 max-lines 上限，文案独立成档）
// ============================================================================

export const zhSettingsMemoryTidy = {
    memoryTidy: {
      recentTitle: '最近整理',
      recentDescription: '每次自动整理改了什么都在这里；不满意可以恢复原样。',
      empty: '还没有整理记录。',
      loadFailed: '整理记录加载失败',
      expandLabel: '查看这次改了什么',
      collapseLabel: '收起',
      summaryMerged: '合并 {groups} 组记忆，收起 {cards} 条旧记忆',
      summaryConflictSuffix: '，另有 {count} 条与说明冲突的记忆被收起',
      summaryConflictOnly: '收起了 {count} 条与说明冲突的记忆',
      summaryNoChange: '检查后没有需要改动的',
      summaryFailed: '整理尝试失败，没有改动记忆',
      mergeLineSources: '{sources} → {result}',
      resultSummaryParens: '（{summary}）',
      putAwayLabel: '收起的记忆：{names}',
      conflictLine: '{name}：{reason}',
      conflictReadOnlyNote: '较早的记录没有保存这条的原文，恢复时这条需手动改回。',
      restoredBadge: '已恢复',
      restoreButton: '恢复这次整理',
      restoreConfirmTitle: '恢复这次整理？',
      restoreConfirmBody: '会把这次整理收起的记忆放回原处，合并出的新记忆会保留但不再自动使用。',
      restoreConfirmOk: '恢复',
      restoreConfirmCancel: '先不',
      restoring: '恢复中…',
      restoreErrors: {
        'already-restored': '这次整理已经恢复过了。',
        'not-applied': '这次整理当时没有实际改动，无需恢复。',
        'snapshot-missing': '这条记录缺少恢复所需的原文，无法自动恢复。',
        'source-file-missing': '相关的记忆文件已经不在了，无法自动恢复。',
        'run-not-found': '找不到这条整理记录。',
        'restore-failed': '恢复中途出错，可以重试；已改动的文件已记录在日志里。',
      },
      previewIntro: '最近一次检查（{date}）：',
      previewWouldChange: '开启后会把 {groups} 组相似记忆合并，收起 {cards} 条旧记忆。',
      previewConflictSuffix: ' 另有 {count} 条与说明冲突的记忆会被收起。',
      previewNothing: '开启后暂时也不会改动任何记忆。',
      previewMissing: '还没做过检查；开启后会先做一次检查，再决定怎么改。',
    },
};
