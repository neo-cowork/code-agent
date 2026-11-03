// ============================================================================
// Settings namespace translations (zh/ExternalImportMcp) — MCP 服务器导入
// （N-EXTHISTORY-IMPORT-K1B-MCP；K1B 新字符串独立成档，类别标签/来源名在
// zhSettingsExternalImport 的 categories/sourceNames 里各加一键）
// ============================================================================

export const zhSettingsExternalImportMcp = {
  externalImportMcp: {
    // 选择步的全局提示（任一来源检出 MCP 类别时显示）
    categoryNote: 'MCP 服务器导入后默认停用，需要逐个手动启用；启用前会先给你看完整命令。',
    previewTitle: 'MCP 服务器（{count}）',
    noImportable: '没有可导入的 MCP 服务器',
    kindLabels: {
      stdio: '本机命令',
      remote: '远程',
    },
    // 跳过原因（页面只显 i18n 标签；宿主原始 reason 只进日志）
    reasonLabels: {
      'source-disabled': '来源应用里已停用，跳过',
      'placeholder-in-command': '命令或地址含 ${{VAR}} 占位符，跳过',
      'invalid-entry': '条目不完整，跳过',
      'duplicate-across-sources': '与其他来源重复，只导入一次',
      'already-exists': 'Neo 已有同名同配置，跳过',
      'name-conflict': 'Neo 已有同名但配置不同，跳过',
      'write-failed': '写入失败',
    },
    // 来源文件状态（缺文件是信息项；坏文件必须给文件级原因，不静默空列表）
    fileStatusLabels: {
      ok: '',
      missing: '未找到 MCP 配置文件',
      unreadable: 'MCP 配置文件读取失败',
      invalid: 'MCP 配置文件解析失败',
    },
    fileErrorSuffix: '：{error}',
    // 结果行状态
    importedLabel: '已导入（未启用）',
    enabledLabel: '已启用',
    skippedLabel: '已跳过',
    neededKeysLine: '需要先补 {keys} 才能用',
    enableToggleLabel: '启用这个 MCP 服务器',
    enableFailed: '启用失败，可稍后在 MCP 设置里重试',
    // 启用确认（先看完整命令行，确认后才真正启用）
    enableDialogTitle: '在电脑上运行这个命令？',
    enableDialogLead: '启用后 Neo 会在你的电脑上运行：',
    enableDialogRemoteLead: '启用后 Neo 会连接这个地址：',
    enableDialogHint: '确认你信任它的来源再启用。',
    enableDialogConfirm: '确认启用',
    enableDialogCancel: '暂不启用',
    resultsTitle: 'MCP 服务器：导入 {imported} 个，跳过 {skipped} 个',
  },
};
