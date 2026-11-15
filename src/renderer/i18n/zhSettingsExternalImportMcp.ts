// ============================================================================
// Settings namespace translations (zh/ExternalImportMcp) — MCP 服务器导入
// （N-EXTHISTORY-IMPORT-K1B-MCP-REDESIGN）
// ============================================================================

export const zhSettingsExternalImportMcp = {
  externalImportMcp: {
    categoryNote: 'MCP 服务器导入后默认停用，需要逐个手动启用；启用前会先给你看完整命令。',
    previewTitle: 'MCP 服务器（{count}）',
    noImportable: '没有可导入的 MCP 服务器',
    kindLabels: {
      stdio: '本机命令',
      remote: '远程',
    },
    reasonLabels: {
      'source-disabled': '已跳过：在原应用里已停用',
      'placeholder-in-command': '已跳过：包含 Neo 无法展开的变量（${…}）',
      'invalid-entry': '已跳过：配置项不完整',
      'duplicate-across-sources': '与其他来源重复，只导入一次',
      'already-exists': '已跳过：Neo 已有同名同配置',
      'name-conflict': '已跳过：Neo 已有同名但配置不同',
      'write-failed': '写入失败',
    },
    fileStatusLabels: {
      ok: '',
      missing: '未找到 MCP 配置文件',
      unreadable: 'MCP 配置文件无法读取',
      invalid: 'MCP 配置文件格式有误，无法解析',
    },
    importedLabel: '已导入（未启用）',
    enabledLabel: '已启用',
    skippedLabel: '已跳过',
    neededKeysLine: '需要先补 {keys} 才能用',
    enableToggleLabel: '启用这个 MCP 服务器',
    enableFailed: '启用失败，可稍后在 MCP 设置里重试',
    enableDialogTitle: '在电脑上运行这个命令？',
    enableDialogLead: '启用后 Neo 会在你的电脑上运行：',
    enableDialogRemoteLead: '启用后 Neo 会连接这个地址：',
    enableDialogHint: '确认你信任它的来源再启用。',
    enableDialogConfirm: '确认启用',
    enableDialogCancel: '暂不启用',
    resultsTitle: 'MCP 服务器：导入 {imported} 个，跳过 {skipped} 个',
  },
};
