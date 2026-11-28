// 执行引擎清单（src/shared/externalEngineManifest.ts）里给人看的两类文字：简介与推荐语。
// 按清单 id 收在这里，界面一律经 utils/engineManifestCopy 取，不直接显示清单里的原文。
// zh 必须与清单原文逐字相同（tests/renderer/utils/engineManifestCopy.test.ts 钉住），
// 清单新增条目时这里两种语言都要补。

export const engineManifestZh = {
  engineManifest: {
    summaries: {
      native: 'Neo 原生执行引擎，使用现有 Provider、工具、权限、Trace 与 Review。',
      codex_cli: '复用本机 Codex 登录态，在受控工作区中执行并归一化事件流。',
      claude_code: '复用本机 Claude Code 登录态，以只读工具和流式事件执行。',
      mimo_code: '复用本机 MiMo-Code 登录态，通过受控 JSON 事件流执行。',
      kimi_code: '复用本机 Kimi Code 登录态，通过归一化 stream-json 执行。',
      kimi_code_acp: '以 Agent Client Protocol 驱动本机 Kimi Code：结构化事件流 + 可续接会话，工具副作用回 Neo 审批。',
      codebuddy_code: '复用本机 WorkBuddy / CodeBuddy 官方账号，以禁用工具的流式会话执行。',
      grok_cli: '复用本机 Grok 官方登录态，以禁用工具和联网搜索的流式会话执行。',
      dsh_cli: '把一条任务交给本机 DeepSeek Harness 的一次性 headless 会话执行，回答由 dsh 自己的凭据与模型产生。',
      qoder_work: '已检测本机 Qoder Work CLI；当前 CLI 尚未登录，执行与模型能力保持关闭。',
      comate_zulu: '已发现本机 CLI/HTTP/SSE 能力证据；生产 Adapter 尚未开放。',
      cursor_cli: '推荐项；尚无本仓实机协议证据，不会伪装成可执行引擎。',
    },
    recommendations: {
      qoder_work: {
        label: '需要登录',
        reason: '请先在 Qoder Work CLI 完成官方登录，再验证模型目录和真实事件流。',
      },
      comate_zulu: {
        label: '可探测',
        reason: '适合后续通过通用 Manifest + Zulu codec 接入。',
      },
      cursor_cli: {
        label: '推荐了解',
        reason: '需要完成官方协议与实机验证后才能在 Neo 中选择。',
      },
    },
  },
};

export const engineManifestEn: typeof engineManifestZh = {
  engineManifest: {
    summaries: {
      native: "Neo's built-in engine. Uses your configured providers, tools, permissions, trace and review.",
      codex_cli: 'Uses the Codex sign-in on this computer and runs in a controlled workspace.',
      claude_code: 'Uses the Claude Code sign-in on this computer, with read-only tools and streamed events.',
      mimo_code: 'Uses the MiMo-Code sign-in on this computer through a controlled event stream.',
      kimi_code: 'Uses the Kimi Code sign-in on this computer through a normalized event stream.',
      kimi_code_acp: 'Drives Kimi Code on this computer over Agent Client Protocol: structured events, resumable sessions, and tool actions approved in Neo.',
      codebuddy_code: 'Uses your WorkBuddy / CodeBuddy account on this computer in a streamed session with tools disabled.',
      grok_cli: 'Uses the Grok sign-in on this computer in a streamed session with tools and web search disabled.',
      dsh_cli: 'Hands one task to a one-off headless DeepSeek Harness session on this computer; answers come from its own credentials and models.',
      qoder_work: 'Qoder Work CLI was found on this computer but is not signed in, so running and model selection stay off.',
      comate_zulu: 'Local CLI/HTTP/SSE support was found; it is not open for use in Neo yet.',
      cursor_cli: 'Suggestion only. Not verified on a real machine yet, so it is not offered as a runnable engine.',
    },
    recommendations: {
      qoder_work: {
        label: 'Sign in required',
        reason: 'Sign in with Qoder Work CLI first to verify its models and live events.',
      },
      comate_zulu: {
        label: 'Detectable',
        reason: 'Planned for future integration once local support is verified.',
      },
      cursor_cli: {
        label: 'Recommended',
        reason: 'Requires official protocol verification before it can be selected in Neo.',
      },
    },
  },
};
