// 隐私边界索引（src/shared/contract/privacyBoundaryIndex.ts）的英文文案，按条目 id 收录（FB-1289）。
// 索引本身是中文数据契约，中文界面直接显示它；英文界面经 utils/privacyBoundaryCopy 换成这里的写法。
// 索引新增条目或改动字段时这里要同步——tests/renderer/utils/privacyBoundaryCopy.test.ts 逐条核对。
import type { PrivacyBoundaryIndexId } from '@shared/contract/privacyBoundaryIndex';

export interface PrivacyBoundaryEntryCopy {
  title: string;
  summary: string;
  data: string[];
  storage: string;
  cloud: string;
  revoke: string;
  /** 条目右侧跳转按钮上的短标签（中文是 actionTarget.label 去掉「打开」）。 */
  actionShortLabel: string;
}

export const privacyBoundaryIndexEn: Record<PrivacyBoundaryIndexId, PrivacyBoundaryEntryCopy> = {
  desktop: {
    title: 'Desktop capture and control',
    summary: 'App screenshots, window text, accessibility clicks and system audio are four separate boundaries.',
    data: ['Screenshots', 'Window titles and text', 'Accessibility tree', 'System audio status'],
    storage: 'Screenshots and derived summaries are kept in the local cache or as attachments of the current conversation.',
    cloud: 'Screenshots or summaries enter the model context only when a cloud model takes part in a desktop task.',
    revoke: 'Revoke Screen Recording / Accessibility in macOS System Settings, or turn off Appshots / Native Desktop.',
    actionShortLabel: 'App screenshot settings',
  },
  voice: {
    title: 'Voice and transcription',
    summary: 'Chat voice, voice paste, desktop audio and channel voice each declare their provider, local/cloud path and logging policy.',
    data: ['Microphone audio', 'Temporary audio files', 'Transcribed text', 'Provider and timing metadata'],
    storage: 'Audio should only touch disk temporarily; transcribed text goes into the current conversation, a clipboard action or a channel reply.',
    cloud: 'Depends on the transcription path; external providers such as Groq, Zhipu and Kimi send audio to the cloud.',
    revoke: 'Revoke microphone permission, or turn off the cloud path in the matching voice / channel / provider settings.',
    actionShortLabel: 'Voice transcription boundaries',
  },
  voiceprint: {
    title: 'Voiceprint identity',
    summary: 'Telling speakers apart during one call and recognizing you across calls are two different things: the first stores nothing and builds no profile; the second needs you to enroll explicitly.',
    data: ['Voiceprint feature vector (a 192-dimension mathematical vector, not audio)', 'Enrollment and latest match timestamps'],
    storage: 'Kept only in the local voiceprint folder, separate from account identity; no raw audio is stored. In-call comparison happens in memory only and is discarded when the call ends. Deleted automatically after 90 days without a match.',
    cloud: 'Never uploaded: the voiceprint vector does not leave this computer and is not included in diagnostic bundles. Recognition accuracy cannot be fully guaranteed, so voiceprints are used only for personalization and telling speakers apart, never to unlock or authorize anything.',
    revoke: 'Turn off voiceprint recognition in voice settings, or clear the enrolled voiceprint; without it core features keep working and only cross-call personalization is lost.',
    actionShortLabel: 'Live voice settings',
  },
  call_recording: {
    title: 'Call recording (for diagnostics)',
    summary: 'Off by default. Only after you turn it on to troubleshoot a problem are the microphone and assistant audio of a call saved on this computer.',
    data: ['Raw microphone audio', 'Raw assistant speech audio', 'Call duration and size in bytes'],
    storage: 'Stored only in the recordings folder of the local data directory, under three limits: kept 7 days, 500 MB in total, at most 10 calls; when any limit is exceeded the oldest recordings are removed automatically. Every cleanup is logged, and Live voice settings show how many were removed, how much space was freed and why.',
    cloud: 'Never uploaded automatically. Recordings are included only when you explicitly tick them while exporting a diagnostic bundle; the bundle itself is exported to a local path you choose, and who receives it is up to you.',
    revoke: 'Turn off call recording in Live voice settings (no new recordings are made after that); existing recordings can be deleted from the recordings folder.',
    actionShortLabel: 'Live voice settings',
  },
  channel: {
    title: 'External channels',
    summary: 'For HTTP API, Feishu and Telegram, the message side and the credential side should be looked at separately.',
    data: ['Inbound messages', 'Sender / chat metadata', 'Attachments', 'Channel token / app secret'],
    storage: 'Channel configuration goes into secure storage; messages are redacted locally by default before entering a conversation.',
    cloud: 'Replies are sent back to the channel; model inference may use the redacted message content.',
    revoke: 'Disable or delete the channel account, or revoke the token on the external platform.',
    actionShortLabel: 'Channel settings',
  },
  mcp_plugin: {
    title: 'MCP and plugins',
    summary: 'The risks of MCP servers, plugin commands, hooks and external services need to be visible on their detail pages.',
    data: ['Server / tool names', 'Tool arguments', 'Resources', 'Plugin manifest', 'Hook context'],
    storage: 'MCP / plugin configuration is stored locally; OAuth tokens are tracked in the matching sign-in inventory.',
    cloud: 'Depends on the server or plugin; open-world and external-service capabilities are treated as high risk by default.',
    revoke: 'Disable the server or plugin, revoke OAuth, or delete the env / header secret.',
    actionShortLabel: 'MCP settings',
  },
  model_provider: {
    title: 'Model providers and API keys',
    summary: 'A provider key is a credential boundary; whether prompts and tool results go to the cloud is a data boundary.',
    data: ['Provider API key', 'Base URL', 'Model request context', 'Tool summaries'],
    storage: 'API keys go into secure storage / Keychain; regular settings reads only show whether one is configured.',
    cloud: 'When a cloud model is used, prompts, tool summaries and necessary attachments are sent to the provider.',
    revoke: "Delete the provider key, switch to a local model, or rotate the key in the provider's console.",
    actionShortLabel: 'Model settings',
  },
  memory: {
    title: 'Memory',
    summary: 'Memory is stored locally by default; it can reach the cloud only when it enters the model context.',
    data: ['Memory text', 'Linked conversations', 'Last updated time', 'Compacted summaries'],
    storage: 'Stored in the local database or the memory folder you configured.',
    cloud: 'Memory snippets selected into the model context are sent to the current provider.',
    revoke: 'Delete, export or turn off the relevant memory in memory settings.',
    actionShortLabel: 'Memory settings',
  },
  telemetry_diagnostic: {
    title: 'Telemetry and diagnostic bundles',
    summary: 'Automatic telemetry is metadata only; failure diagnostic bundles and user exports are separate boundaries.',
    data: ['Run metadata', 'Error categories', 'Version fingerprint', 'Scrubbed raw payload'],
    storage: 'Diagnostic bundles are generated on this computer first and scrubbed before upload.',
    cloud: 'Automatic telemetry contains no full prompts or code; uploading a diagnostic bundle needs a separate explanation.',
    revoke: 'Turn off telemetry; uploading a diagnostic bundle stays an explicit action.',
    actionShortLabel: 'Privacy guard',
  },
};
