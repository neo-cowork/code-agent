// 隐私防线页底部两张表的英文文案：语音转写路径（src/shared/contract/voiceTranscription.ts）
// 与凭证清单（src/shared/contract/authInventory.ts）。两份契约本身是中文数据，中文界面直接显示；
// 英文界面经 utils/privacyBoundaryCopy 换成这里的写法。契约新增条目或改字段时这里要同步——
// tests/renderer/utils/privacyVoiceAuthCopy.test.ts 逐条核对。
import type { AuthInventoryItemId } from '@shared/contract/authInventory';
import type { VoiceTranscriptionPathId } from '@shared/contract/voiceTranscription';

export interface VoiceTranscriptionPathCopy {
  title: string;
  trigger: string;
  providers: string[];
  cloud: string;
  temporaryStorage: string;
  logPolicy: string;
}

export interface AuthInventoryItemCopy {
  title: string;
  examples: string[];
  storage: string;
  display: string;
  diagnosticPolicy: string;
}

export const voiceTranscriptionPathsEn: Record<VoiceTranscriptionPathId, VoiceTranscriptionPathCopy> = {
  chat_voice: {
    title: 'Chat voice input',
    trigger: 'Hold or click the voice button in the chat input box.',
    providers: ['Groq Whisper'],
    cloud: 'Currently uses Groq Whisper; audio is sent to an external service.',
    temporaryStorage: 'The main process writes the audio file to the system temp folder and deletes it once transcription finishes.',
    logPolicy: 'Logs record only size, mimeType, duration and error codes, never the transcribed text.',
  },
  voice_paste: {
    title: 'Voice Paste',
    trigger: 'Start a global voice paste recording and paste the transcript into the current app.',
    providers: ['Local whisper-cpp', 'Groq Whisper', 'Zhipu/Kimi post-processing'],
    cloud: 'Prefers local whisper-cpp; falls back to Groq when it is unavailable, and post-processing may call Zhipu or Kimi.',
    temporaryStorage: 'The recording is written to the system temp folder and cleaned up after transcription or pasting finishes.',
    logPolicy: 'Logs record only provider, character count, duration and error codes, never fragments of the text.',
  },
  desktop_audio: {
    title: 'Desktop or meeting audio',
    trigger: 'Turn on desktop audio, meeting transcription or the Native Desktop audio capability.',
    providers: ['whisper-cpp', 'qwen3-asr', 'none'],
    cloud: 'Depends on the current Native Desktop ASR engine; local engines never leave the device.',
    temporaryStorage: 'Audio segments should exist only briefly in the local temp folder or the desktop capture cache.',
    logPolicy: 'Logs record engine, duration, number of audio segments and error codes, never the transcribed text.',
  },
  channel_audio: {
    title: 'Channel voice messages',
    trigger: 'A channel such as Feishu, Telegram or the HTTP API receives a voice message or audio attachment.',
    providers: ['The ASR provider configured in the channel adapter'],
    cloud: 'Independent of the desktop Whisper settings; whether audio leaves the device is decided by the channel ASR configuration.',
    temporaryStorage: 'Downloaded audio attachments should be kept only temporarily on this device and cleaned up with the message handling cycle.',
    logPolicy: 'Logs record only channel, provider, duration and error codes, never the text.',
  },
};

// 凭证清单的 id 带 api_key / token 字样，写成对象键会被 rendererTokenBoundary 规则 A 当作凭证形成员名，
// 所以这里用 [id, 文案] 列表。
const AUTH_INVENTORY_EN_ENTRIES: Array<[AuthInventoryItemId, AuthInventoryItemCopy]> = [
  ['provider.api_key', {
    title: 'Model provider API keys',
    examples: ['OpenAI', 'Anthropic', 'Groq', 'Moonshot', 'Zhipu'],
    storage: 'secure storage / Keychain / encrypted backup',
    display: 'Normal reads only show apiKeyConfigured; the full key is never displayed.',
    diagnosticPolicy: 'Diagnostic bundles and logs must redact provider keys.',
  }],
  ['channel.token', {
    title: 'Channel tokens and app secrets',
    examples: ['HTTP API key', 'Feishu appSecret', 'Telegram botToken'],
    storage: 'Channel configuration is kept in secure storage.',
    display: 'Forms default to password/masked; copying the full value must be an explicit action.',
    diagnosticPolicy: 'Channel raw payloads and logs hide token, secret, authorization and cookie by default.',
  }],
  ['mcp.env', {
    title: 'MCP environment variable credentials',
    examples: ['TOKEN', 'API_KEY', 'PRIVATE_KEY'],
    storage: 'MCP server config, stored locally.',
    display: 'Env values that look like secrets only show configured/masked by default.',
    diagnosticPolicy: 'MCP call logs recursively hide secret-like env values.',
  }],
  ['mcp.header', {
    title: 'MCP header credentials',
    examples: ['Authorization', 'X-API-Key', 'Cookie'],
    storage: 'MCP server config, stored locally.',
    display: 'Header values are masked by default; editing the raw JSON needs a risk warning.',
    diagnosticPolicy: 'Diagnostics and logs hide Authorization, cookie and API key values.',
  }],
  ['mcp.oauth', {
    title: 'MCP OAuth authorization',
    examples: ['access token', 'refresh token', 'client secret'],
    storage: 'OAuth token store / secure storage.',
    display: 'The UI only shows connected, expired, reauthorize and revoke; tokens are never displayed.',
    diagnosticPolicy: 'OAuth tokens never enter ordinary settings payloads, logs or diagnostics in plain text.',
  }],
  ['browser.relay_token', {
    title: 'Browser relay token',
    examples: ['Chrome extension token', 'local relay token'],
    storage: 'Browser extension local storage and the local relay configuration.',
    display: 'Only the token hint and connection status are shown; the full token appears only in controlled management actions.',
    diagnosticPolicy: 'Relay token, cookie and authorization are redacted in logs and diagnostic bundles.',
  }],
];

export const authInventoryEn = new Map<AuthInventoryItemId, AuthInventoryItemCopy>(AUTH_INVENTORY_EN_ENTRIES);
