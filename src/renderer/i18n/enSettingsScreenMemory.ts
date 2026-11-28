// ============================================================================
// Settings namespace translations (en/ScreenMemory) — Settings > Screen Memory
// （N-FIX-SETTINGS-ENGINEERING-JARGON-SCREENMEM-STT-COPY-SCREENMEM；enSettingsWork 已贴 max-lines 上限，
//  openchronicle 块整体独立成档，经 enSettingsWork 的 openchronicle 键挂回，t.settings.openchronicle.* 路径不变）
// ============================================================================

export const enSettingsScreenMemory = {
    operationFailed: 'That did not work. Please try again.',
    webUnavailable: 'Screen memory only works in the macOS desktop app, because it keeps a record on this computer of what you look at across apps.',
    refresh: 'Refresh',
    notInstalled: 'This computer does not have OpenChronicle, the companion program screen memory needs, so the switches below cannot be used yet. After installing it, press Refresh.',
    runError: 'Screen memory is not running properly. Press Refresh to check again; if that does not help, turn the switch off and on.',
    stateLabels: {
      running: 'Running',
      starting: 'Starting...',
      stopping: 'Stopping...',
      stopped: 'Stopped',
      error: 'Something went wrong',
    },
    header: {
      introPrefix: 'Uses the companion program ',
      introMiddle: ' to ',
      introSuffix: 'record your work across apps, so Agent Neo knows what you were just doing when a new chat starts.',
      warning: 'Once enabled, OpenChronicle keeps running in the background, even after Agent Neo closes, until you turn it off here.',
    },
    control: {
      enableScreenMemory: 'Enable screen memory',
      description: 'When on, Neo keeps a background record of what you look at across apps, even after Agent Neo closes. Turn it off to stop recording.',
    },
    status: {
      state: 'Status',
      notInstalled: 'Not installed',
      connection: 'Connection to Neo',
      connected: '✓ Connected',
      disconnected: '— Not connected',
      pending: 'New records',
      pendingCount: { one: '{count} item waiting to be organised', other: '{count} items waiting to be organised' },
      kept: 'Memories',
      keptCount: { one: '{count} memory kept', other: '{count} memories kept' },
      dataDirPrefix: 'Saved in: ',
    },
    autoInject: {
      title: 'Start new chats with what you were just doing',
      description: 'When you start a new chat, Neo first adds a short summary of what you were just doing, so answers fit the task at hand.',
    },
    blacklist: {
      title: 'Apps and websites kept out of chats',
      description: 'The summary added to new chats never includes the apps and websites listed below. OpenChronicle itself may still record them.',
      appsLabel: 'Apps (one per line)',
      appsPlaceholder: '1Password\nBitwarden\nWeChat',
      urlPatternsLabel: 'Websites (one per line; * means any characters)',
      urlPatternsPlaceholder: '*.bank.com\naccounts.google.com/signin*',
    },
    screenMemory: {
      refresh: 'Refresh',
      webDescription: 'The web version cannot control screen memory on this computer. Set it up in the desktop app.',
      webBody: 'Screen memory keeps a record on your computer of what you look at across apps, which only the Agent Neo desktop app installed on that computer can do.',
      pageDescription: 'Choose what screen memory records, whether new chats use it, and what stays out of chats. Preview and manual recording are collapsed by default.',
      providerStateLabels: {
        running: 'Running',
        starting: 'Starting',
        stopping: 'Stopping',
        stopped: 'Stopped',
        available: 'Available',
        unavailable: 'Unavailable',
        error: 'Something went wrong',
      },
      providerKindLabels: {
        bundled: 'Built in',
        sidecar: 'Runs with the app',
        daemon: 'Runs in the background',
      },
      status: {
        currentRuntime: 'Running in',
        desktopApp: 'Desktop app',
        webFallback: 'Web version',
        automaticScreenMemory: 'Automatic screen memory',
        notInstalled: 'Not installed',
        openchronicleConfigurable: 'Set it up below',
        desktopAvailable: 'Available in the desktop app',
        manualDesktopActivity: 'Manual desktop activity',
        nativeDesktopAvailable: 'Available',
        tauriOnly: 'Needs the latest desktop app',
      },
      activityContext: {
        empty: {
          recentContextSummary: 'Reading what was recorded recently.',
          agentInjectionPreview: 'Reading the summary new chats will start with.',
        },
        nothingYet: {
          recentContextSummary: 'Nothing from your screen to refer to yet.',
          agentInjectionPreview: 'New chats will not include anything from screen memory for now.',
        },
        error: {
          recentContextUnavailable: 'Recent records cannot be read right now.',
          agentInjectionUnavailable: 'This new chat will not include anything from screen memory.',
        },
        capturedAt: {
          none: 'Nothing recorded yet',
        },
        sourceLabels: {
          automatic_background: 'Automatic',
          manual_capture: 'Manual recording',
          meeting_audio: 'Meeting audio',
          screenshot_analysis: 'Screenshot reading',
          unknown: 'Unknown source',
        },
        title: 'Content preview',
        degraded: 'Read error',
        degradedMessage: 'Screen memory content cannot be read right now. Press Refresh to try again.',
        noSources: 'No sources yet',
        recentContextPreview: 'Recently recorded',
        agentInjectionPreview: 'Summary new chats start with',
        evidenceFallback: 'Only summaries are shown here; where screenshots and files are saved is never shown.',
      },
      nativeUnavailable: {
        title: 'This version cannot record desktop activity manually',
        description: 'Manually recording desktop activity, screenshots and meeting audio needs the latest Agent Neo desktop app.',
      },
      captureSection: {
        title: 'Recording settings',
        openchronicleTitle: 'Automatic screen memory',
        openchronicleDescription: 'Uses the companion program OpenChronicle to record your work across apps in the background, so new chats can refer to it.',
      },
      diagnostics: {
        title: 'Preview and manual recording',
        description: 'See what new chats will start with, or record desktop activity manually. Collapsed by default.',
        activityTitle: 'What new chats refer to',
        activityDescription: 'See what was recorded recently and the summary new chats start with; where screenshots are saved is never shown.',
        nativeDesktopTitle: 'Record desktop activity manually',
        nativeDesktopDescription: 'Start or stop recording desktop activity, screenshots and meeting audio here, and look through what was recorded.',
      },
    },
};
