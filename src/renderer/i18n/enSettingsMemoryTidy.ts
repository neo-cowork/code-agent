// ============================================================================
// Settings namespace translations (en/MemoryTidy) —「Recent tidy-ups」block
// （N-MEM-CONSOLIDATION-HISTORY-UNDO；enSettingsWork 已贴 max-lines 上限，文案独立成档）
// ============================================================================

export const enSettingsMemoryTidy = {
    memoryTidy: {
      recentTitle: 'Recent tidy-ups',
      recentDescription: 'See what each automatic tidy-up changed, and put it back if you prefer.',
      empty: 'No tidy-ups yet.',
      loadFailed: 'Failed to load tidy-up history',
      expandLabel: 'See what changed',
      collapseLabel: 'Collapse',
      summaryMerged: 'merged {groups} memory group(s), put away {cards} older ones',
      summaryConflictSuffix: ', plus {count} conflicting memories put away',
      summaryConflictOnly: 'put away {count} conflicting memories',
      summaryNoChange: 'checked and found nothing to change',
      summaryFailed: 'tidy-up attempt failed, nothing was changed',
      mergeLineSources: '{sources} → {result}',
      resultSummaryParens: ' ({summary})',
      putAwayLabel: 'Put away: {names}',
      conflictLine: '{name}: {reason}',
      conflictReadOnlyNote: 'This older record did not keep the original text, so this one must be restored by hand.',
      restoredBadge: 'Restored',
      restoreButton: 'Restore this tidy-up',
      restoreConfirmTitle: 'Restore this tidy-up?',
      restoreConfirmBody: 'The memories put away by this tidy-up return to your list; the merged card stays but is no longer used automatically.',
      restoreConfirmOk: 'Restore',
      restoreConfirmCancel: 'Not now',
      restoring: 'Restoring…',
      restoreErrors: {
        'already-restored': 'This tidy-up has already been restored.',
        'not-applied': 'This tidy-up changed nothing at the time, so there is nothing to restore.',
        'snapshot-missing': 'This record is missing the original text needed to restore automatically.',
        'source-file-missing': 'A related memory file no longer exists, so it cannot be restored automatically.',
        'run-not-found': 'This tidy-up record cannot be found.',
        'restore-failed': 'Restoring stopped partway; you can retry. Changed files were logged.',
      },
      previewIntro: 'Last check ({date}):',
      previewWouldChange: 'if turned on, {groups} group(s) of similar memories would be merged and {cards} older ones put away.',
      previewConflictSuffix: ' {count} conflicting memories would also be put away.',
      previewNothing: 'if turned on, nothing would change for now.',
      previewMissing: 'No check has run yet; after turning it on, a check runs first and decides what to change.',
    },
};
