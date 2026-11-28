// ============================================================================
// Settings namespace translations (zh/ScreenMemory) — 设置页「屏幕记忆」
// （N-FIX-SETTINGS-ENGINEERING-JARGON-SCREENMEM-STT-COPY-SCREENMEM；zhSettingsWork 已贴 max-lines 上限，
//  openchronicle 块整体独立成档，经 zhSettingsWork 的 openchronicle 键挂回，t.settings.openchronicle.* 路径不变）
// 文件名必须匹配 zhSettings*.ts：设置页黑话门（scripts/ci/check-settings-jargon.mjs）按这个名字扫源码。
// ============================================================================

export const zhSettingsScreenMemory = {
    operationFailed: '没能完成这次操作，请再试一次。',
    webUnavailable: '屏幕记忆只能在 macOS 桌面版里使用：它要在这台电脑上持续记下你在各个应用里看过的内容。',
    refresh: '刷新',
    notInstalled: '这台电脑还没有安装屏幕记忆需要的配套程序 OpenChronicle，下面的开关暂时不能用。装好后点「刷新」即可。',
    runError: '屏幕记忆没有正常运行。请点「刷新」重新检查，还不行就把开关关掉再打开。',
    stateLabels: {
      running: '运行中',
      starting: '启动中…',
      stopping: '停止中…',
      stopped: '已停止',
      error: '出了问题',
    },
    header: {
      introPrefix: '借助配套程序 ',
      introMiddle: '，',
      introSuffix: '记下你在各个应用里的工作，让 Agent Neo 在新对话开始时知道你刚才在做什么。',
      warning: '开启后 OpenChronicle 会一直在后台运行（关掉 Agent Neo 也不停），直到你在这里把它关掉。',
    },
    control: {
      enableScreenMemory: '启用屏幕记忆',
      description: '打开后，Neo 会在后台持续记下你在各个应用里看过的内容，退出 Agent Neo 也不会停；关闭后停止记录。',
    },
    status: {
      state: '运行状态',
      notInstalled: '未安装',
      connection: '与 Neo 的连接',
      connected: '✓ 已连通',
      disconnected: '— 未连接',
      pending: '新记录',
      pendingCount: { one: '{count} 条等待整理', other: '{count} 条等待整理' },
      kept: '记忆',
      keptCount: { one: '已记住 {count} 条', other: '已记住 {count} 条' },
      dataDirPrefix: '记录保存在：',
    },
    autoInject: {
      title: '新对话自动带上刚才在做的事',
      description: '开始新对话时，Neo 会先带上一段你刚才在做什么的简短摘要，回答更贴近手头的事。',
    },
    blacklist: {
      title: '不带进对话的应用和网站',
      description: '新对话自动带上的摘要里，不会出现下面列出的应用和网站。OpenChronicle 自己仍可能记下它们。',
      appsLabel: '应用（每行一个）',
      appsPlaceholder: '1Password\nBitwarden\n微信',
      urlPatternsLabel: '网站（每行一个，* 代表任意字符）',
      urlPatternsPlaceholder: '*.bank.com\naccounts.google.com/signin*',
    },
    screenMemory: {
      refresh: '刷新',
      webDescription: '网页版不能控制这台电脑上的屏幕记忆，请在桌面版里设置。',
      webBody: '屏幕记忆要在你的电脑上持续记下你在各个应用里看过的内容，只有装在这台电脑上的 Agent Neo 桌面版能做到。',
      pageDescription: '设置屏幕记忆记什么、新对话带不带上，以及哪些内容不带进对话。预览和手动记录默认收起。',
      providerStateLabels: {
        running: '运行中',
        starting: '启动中',
        stopping: '停止中',
        stopped: '已停止',
        available: '可用',
        unavailable: '不可用',
        error: '出了问题',
      },
      providerKindLabels: {
        bundled: '内置',
        sidecar: '随应用运行',
        daemon: '后台常驻',
      },
      status: {
        currentRuntime: '正在使用',
        desktopApp: '桌面版',
        webFallback: '网页版',
        automaticScreenMemory: '自动屏幕记忆',
        notInstalled: '未安装',
        openchronicleConfigurable: '可以在下面设置',
        desktopAvailable: '桌面版可用',
        manualDesktopActivity: '手动桌面活动',
        nativeDesktopAvailable: '可用',
        tauriOnly: '需要最新版桌面版',
      },
      activityContext: {
        empty: {
          recentContextSummary: '正在读取最近记下的内容。',
          agentInjectionPreview: '正在读取新对话会带上的摘要。',
        },
        nothingYet: {
          recentContextSummary: '还没有可以参考的屏幕内容。',
          agentInjectionPreview: '新对话暂时不会带上屏幕记忆的内容。',
        },
        error: {
          recentContextUnavailable: '暂时读不到最近记下的内容。',
          agentInjectionUnavailable: '这次新对话不会带上屏幕记忆的内容。',
        },
        capturedAt: {
          none: '还没有记录',
        },
        sourceLabels: {
          automatic_background: '自动后台',
          manual_capture: '手动采集',
          meeting_audio: '会议音频',
          screenshot_analysis: '截图分析',
          unknown: '未知来源',
        },
        title: '内容预览',
        degraded: '读取出错',
        degradedMessage: '暂时读不到屏幕记忆的内容，请点「刷新」重试。',
        noSources: '还没有记录来源',
        recentContextPreview: '最近记下的内容',
        agentInjectionPreview: '新对话会带上的摘要',
        evidenceFallback: '这里只显示摘要，不会显示截图和文件的保存位置。',
      },
      nativeUnavailable: {
        title: '这个版本不能手动记录桌面活动',
        description: '手动记录桌面活动、截图和会议录音，需要最新版的 Agent Neo 桌面版。',
      },
      captureSection: {
        title: '记录设置',
        openchronicleTitle: '自动屏幕记忆',
        openchronicleDescription: '借助配套程序 OpenChronicle，在后台记下你在各个应用里的工作，新对话开始时可以参考。',
      },
      diagnostics: {
        title: '预览与手动记录',
        description: '看看新对话会带上哪些内容，或手动记录桌面活动。默认收起。',
        activityTitle: '新对话会参考的内容',
        activityDescription: '看看最近记下了什么，以及新对话开始时会带上的摘要；不会显示截图的保存位置。',
        nativeDesktopTitle: '手动记录桌面活动',
        nativeDesktopDescription: '在这里手动开始或停止记录桌面活动、截图和会议录音，并查看记下的内容。',
      },
    },
};
