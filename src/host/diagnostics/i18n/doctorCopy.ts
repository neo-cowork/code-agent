// ============================================================================
// 诊断（Doctor）报告里给人看的文字：检查项名称、结论、建议。
// 报告在宿主侧生成，所以文案也在宿主侧按界面语言选（readUiLanguage，读不到按中文）——
// 做法同 tools/modules/design/generationCostConfirm.ts（FB-1285）。
// 各检查只拿 doctorCopy() 的结果拼报告，自己不写任何语言的字面量（FB-1291）。
// zh 一栏与改动前逐字相同。
// ============================================================================
import { readUiLanguage } from '../../session/sessionTitleHostPrompt';

interface DoctorCopy {
  runner: {
    overallTimeout: (seconds: string) => string;
    checkTimeout: (seconds: string) => string;
    timeoutSuggestion: string;
    skippedNetwork: string;
    checkThrew: string;
    checkThrewSuggestion: string;
  };
  names: {
    quickModelAuth: string;
    quickModelHealth: string;
    hooksConfig: string;
    hooksConfigOf: (source: string) => string;
    appVersion: string;
    providerHealthMonitor: string;
  };
  network: {
    noApiKey: string;
    connectFailed: string;
    internalError: (message: string) => string;
    checkException: string;
  };
  providerHealth: {
    noRuntimeData: string;
    degradedSuggestion: string;
    recoveringSuggestion: string;
    unavailableSuggestion: string;
  };
  version: {
    updateServiceMissing: string;
    updateAvailable: (current: string, latest: string) => string;
    updateSuggestion: string;
    upToDate: (current: string) => string;
    checkFailed: (message: string) => string;
    checkFailedSuggestion: (current: string) => string;
  };
  mcp: {
    connected: string;
    lazy: string;
    connecting: string;
    connectingSuggestion: string;
    disconnected: string;
    disconnectedSuggestion: string;
    error: string;
    errorSuggestion: string;
    noServers: string;
  };
  hooks: {
    notConfigured: string;
    jsonParseFailed: string;
    jsonParseSuggestion: string;
    loaded: (count: number) => string;
    noHooks: string;
    parseError: string;
    parseErrorSuggestion: string;
  };
  quickModel: {
    authFailed: (provider: string, model: string, status: number | string) => string;
    authFailedSuggestion: string;
    noRecentFailure: string;
    modelLabel: (provider: string, model: string) => string;
    statusLabel: (status: number | string) => string;
    invalidResponse: string;
    callFailed: (reason: string) => string;
    degraded: (modelLabel: string, reasonLabel: string, statusLabel: string) => string;
    degradedSuggestion: string;
  };
  environment: {
    upgradeNode: string;
    configDirAutoCreated: string;
    databaseAutoCreated: string;
    databaseNotReady: string;
    restartForMigration: string;
    checkDatabasePermissions: string;
    checkConfigDirAccess: string;
  };
}

const DOCTOR_COPY: Record<'zh' | 'en', DoctorCopy> = {
  zh: {
    runner: {
      overallTimeout: (seconds) => `整体检查超时（${seconds}s）`,
      checkTimeout: (seconds) => `检查超时（${seconds}s）`,
      timeoutSuggestion: '可能是网络或外部进程响应慢；可重试',
      skippedNetwork: '已跳过（skipNetwork=true）',
      checkThrew: '检查抛错',
      checkThrewSuggestion: '查看 details 排查；如非可恢复错误，提 issue',
    },
    names: {
      quickModelAuth: '快模型鉴权',
      quickModelHealth: '快模型健康',
      hooksConfig: 'Hooks 配置',
      hooksConfigOf: (source) => `${source} hooks 配置`,
      appVersion: '应用版本',
      providerHealthMonitor: 'Provider 健康监控',
    },
    network: {
      noApiKey: '未配置 API Key',
      connectFailed: '连接失败',
      internalError: (message) => `内部错误: ${message}`,
      checkException: '检查异常',
    },
    providerHealth: {
      noRuntimeData: '当前后端进程尚无运行时数据（启动/重启后未发起过 API 请求）',
      degradedSuggestion: '错误率偏高，可观察是否需要切换 provider',
      recoveringSuggestion: '正在恢复中，连续成功 3 次后会回到 healthy',
      unavailableSuggestion: '错误率超过 70%，建议临时切换到其他 provider',
    },
    version: {
      updateServiceMissing: 'UpdateService 未初始化（CLI 模式）',
      updateAvailable: (current, latest) => `有新版可更新：${current} → ${latest}`,
      updateSuggestion: '在设置面板点"检查更新"或直接下载新版',
      upToDate: (current) => `已是最新版本 v${current}`,
      checkFailed: (message) => `更新检查失败：${message}`,
      checkFailedSuggestion: (current) => `可能是网络问题，可忽略；当前版本 v${current}`,
    },
    mcp: {
      connected: '已连接',
      lazy: '懒加载（尚未触发首次调用）',
      connecting: '连接中',
      connectingSuggestion: '如果长时间停在此状态，检查 server 是否真的在启动',
      disconnected: '未连接',
      disconnectedSuggestion: '若希望立即可用，可在 MCP 面板手动连接',
      error: '连接错误',
      errorSuggestion: '检查 server 命令、网络、依赖；详细错误见 details',
      noServers: '尚未配置任何 MCP server',
    },
    hooks: {
      notConfigured: '未配置（不存在）',
      jsonParseFailed: 'JSON 解析失败',
      jsonParseSuggestion: '检查 JSON 语法（引号、逗号、括号匹配）',
      loaded: (count) => `${count} 个 hook 已加载`,
      noHooks: '文件可解析但无 hook',
      parseError: '解析出错',
      parseErrorSuggestion: '查看上面 details 中的解析错误',
    },
    quickModel: {
      authFailed: (provider, model, status) =>
        `快模型（${provider} / ${model}）鉴权失败（HTTP ${status}），API Key 可能已失效或过期`,
      authFailedSuggestion: '请前往模型设置更新对应 Provider 的 API Key',
      noRecentFailure: '最近未检测到快模型失败',
      modelLabel: (provider, model) => `（${provider} / ${model}）`,
      statusLabel: (status) => `，HTTP ${status}`,
      invalidResponse: '响应格式异常',
      callFailed: (reason) => `调用失败：${reason}`,
      degraded: (modelLabel, reasonLabel, statusLabel) =>
        `快模型${modelLabel}${reasonLabel}${statusLabel}，记忆判定或写回可能已降级`,
      degradedSuggestion: '请检查模型 Provider 的 endpoint、模型兼容性与服务状态后重试',
    },
    environment: {
      upgradeNode: '请升级 Node.js 到 18 或以上版本',
      configDirAutoCreated: '应用首次启动会自动创建配置目录，可忽略此警告',
      databaseAutoCreated: '应用首次运行时会自动创建数据库，可忽略',
      databaseNotReady: '数据库连接尚未初始化，请在应用启动完成后重试诊断',
      restartForMigration: '重启应用以执行数据库迁移；若仍失败，请备份后检查数据库',
      checkDatabasePermissions: '检查数据库文件权限，或删除后让应用重建',
      checkConfigDirAccess: '检查配置目录的访问权限',
    },
  },
  en: {
    runner: {
      overallTimeout: (seconds) => `All checks timed out (${seconds}s)`,
      checkTimeout: (seconds) => `Check timed out (${seconds}s)`,
      timeoutSuggestion: 'The network or an external process may be slow. You can try again.',
      skippedNetwork: 'Skipped (network checks are off for this run)',
      checkThrew: 'The check itself failed',
      checkThrewSuggestion: 'See the details to troubleshoot. If it keeps happening, report it.',
    },
    names: {
      quickModelAuth: 'Fast model sign-in',
      quickModelHealth: 'Fast model health',
      hooksConfig: 'Hooks configuration',
      hooksConfigOf: (source) => `${source} hooks configuration`,
      appVersion: 'App version',
      providerHealthMonitor: 'Provider health monitor',
    },
    network: {
      noApiKey: 'No API key configured',
      connectFailed: 'Connection failed',
      internalError: (message) => `Internal error: ${message}`,
      checkException: 'Check failed unexpectedly',
    },
    providerHealth: {
      noRuntimeData: 'No runtime data yet (no API request has been made since the app started)',
      degradedSuggestion: 'Error rate is elevated. Watch it and consider switching provider.',
      recoveringSuggestion: 'Recovering. It returns to healthy after 3 successful requests in a row.',
      unavailableSuggestion: 'Error rate is above 70%. Consider switching to another provider for now.',
    },
    version: {
      updateServiceMissing: 'Update check is not available here (CLI mode)',
      updateAvailable: (current, latest) => `Update available: ${current} → ${latest}`,
      updateSuggestion: 'Select "Check for updates" in Settings, or download the new version.',
      upToDate: (current) => `Up to date (v${current})`,
      checkFailed: (message) => `Update check failed: ${message}`,
      checkFailedSuggestion: (current) => `Probably a network issue; safe to ignore. Current version v${current}`,
    },
    mcp: {
      connected: 'Connected',
      lazy: 'Loads on first use (not called yet)',
      connecting: 'Connecting',
      connectingSuggestion: 'If it stays here for long, check that the server is actually starting.',
      disconnected: 'Not connected',
      disconnectedSuggestion: 'To use it right away, connect it manually in the MCP panel.',
      error: 'Connection error',
      errorSuggestion: 'Check the server command, network and dependencies. See details for the error.',
      noServers: 'No MCP server configured yet',
    },
    hooks: {
      notConfigured: 'Not configured (no file)',
      jsonParseFailed: 'JSON could not be parsed',
      jsonParseSuggestion: 'Check the JSON syntax (quotes, commas, matching brackets).',
      loaded: (count) => (count === 1 ? '1 hook loaded' : `${count} hooks loaded`),
      noHooks: 'File is valid but defines no hooks',
      parseError: 'Could not read the configuration',
      parseErrorSuggestion: 'See the parse error in details above.',
    },
    quickModel: {
      authFailed: (provider, model, status) =>
        `Fast model (${provider} / ${model}) sign-in failed (HTTP ${status}). The API key may be invalid or expired.`,
      authFailedSuggestion: 'Update the API key for this provider in model settings.',
      noRecentFailure: 'No recent fast model failures',
      modelLabel: (provider, model) => ` (${provider} / ${model})`,
      statusLabel: (status) => `, HTTP ${status}`,
      invalidResponse: ' returned an unexpected response format',
      callFailed: (reason) => ` call failed: ${reason}`,
      degraded: (modelLabel, reasonLabel, statusLabel) =>
        `Fast model${modelLabel}${reasonLabel}${statusLabel}. Memory decisions or write-back may be degraded.`,
      degradedSuggestion: "Check the provider's endpoint, model compatibility and service status, then try again.",
    },
    environment: {
      upgradeNode: 'Upgrade Node.js to version 18 or later.',
      configDirAutoCreated: 'The app creates the config folder on first launch; you can ignore this warning.',
      databaseAutoCreated: 'The app creates the database on first run; you can ignore this.',
      databaseNotReady: 'The database connection is not ready yet. Run diagnostics again after the app finishes starting.',
      restartForMigration: 'Restart the app to run the database migration. If it still fails, back up and inspect the database.',
      checkDatabasePermissions: 'Check the database file permissions, or delete it and let the app rebuild it.',
      checkConfigDirAccess: 'Check access permissions on the config folder.',
    },
  },
};

/** 当前界面语言下的诊断文案。每次生成报告时取一次，语言切换后下一份报告即生效。 */
export function doctorCopy(): DoctorCopy {
  return DOCTOR_COPY[readUiLanguage()];
}
