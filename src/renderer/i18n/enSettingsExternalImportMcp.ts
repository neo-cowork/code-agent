// ============================================================================
// Settings namespace translations (en/ExternalImportMcp) — MCP servers import
// (N-EXTHISTORY-IMPORT-K1B-MCP-REDESIGN; shape mirrors zhSettingsExternalImportMcp)
// ============================================================================

export const enSettingsExternalImportMcp = {
  externalImportMcp: {
    categoryNote: 'MCP servers are imported disabled; enable them one by one after reviewing the full command.',
    previewTitle: 'MCP servers ({count})',
    noImportable: 'No importable MCP servers',
    kindLabels: {
      stdio: 'Local command',
      remote: 'Remote',
    },
    reasonLabels: {
      'source-disabled': 'Skipped: disabled in the source app',
      'placeholder-in-command': 'Skipped: uses a variable (${…}) Neo cannot expand',
      'invalid-entry': 'Skipped: incomplete entry',
      'duplicate-across-sources': 'Duplicate of another source, imported once',
      'already-exists': 'Skipped: already present in Neo',
      'name-conflict': 'Skipped: name already in use with a different config',
      'write-failed': 'Write failed',
    },
    fileStatusLabels: {
      ok: '',
      missing: 'No MCP config file found',
      unreadable: 'MCP config file could not be read',
      invalid: 'MCP config file has syntax errors and could not be parsed',
    },
    importedLabel: 'Imported (off)',
    enabledLabel: 'Enabled',
    skippedLabel: 'Skipped',
    neededKeysLine: 'Needs {keys} before it can work',
    enableToggleLabel: 'Enable this MCP server',
    enableFailed: 'Failed to enable; retry later from MCP settings',
    enableDialogTitle: 'Run this on your computer?',
    enableDialogLead: 'Enabling lets Neo run this on your computer:',
    enableDialogRemoteLead: 'Enabling lets Neo connect to this address:',
    enableDialogHint: 'Make sure you trust where it comes from before enabling.',
    enableDialogConfirm: 'Enable',
    enableDialogCancel: 'Not now',
    resultsTitle: 'MCP servers: imported {imported}, skipped {skipped}',
  },
};
