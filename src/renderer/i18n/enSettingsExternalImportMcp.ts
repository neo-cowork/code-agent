// ============================================================================
// Settings namespace translations (en/ExternalImportMcp) — MCP servers import
// (N-EXTHISTORY-IMPORT-K1B-MCP; shape must mirror zhSettingsExternalImportMcp)
// ============================================================================

export const enSettingsExternalImportMcp = {
  externalImportMcp: {
    categoryNote: 'MCP servers are imported disabled; enable them one by one, with the full command shown first.',
    previewTitle: 'MCP servers ({count})',
    noImportable: 'No importable MCP servers',
    kindLabels: {
      stdio: 'Local command',
      remote: 'Remote',
    },
    reasonLabels: {
      'source-disabled': 'Disabled in the source app, skipped',
      'placeholder-in-command': 'Command or URL contains a ${{VAR}} placeholder, skipped',
      'invalid-entry': 'Incomplete entry, skipped',
      'duplicate-across-sources': 'Duplicate of another source, imported once',
      'already-exists': 'Already present in Neo, skipped',
      'name-conflict': 'Name already in use with a different config, skipped',
      'write-failed': 'Write failed',
    },
    fileStatusLabels: {
      ok: '',
      missing: 'No MCP config file found',
      unreadable: 'MCP config file could not be read',
      invalid: 'MCP config file could not be parsed',
    },
    fileErrorSuffix: ': {error}',
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
