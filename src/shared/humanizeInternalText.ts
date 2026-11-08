export type InternalTextLanguage = 'zh' | 'en';

export type InternalTextFormat =
  | 'uuid'
  | 'session_id'
  | 'call_id'
  | 'ou_id'
  | 'internal_tool_name'
  | 'english_state_word'
  | 'sandbox_exec'
  | 'temp_path'
  | 'raw_json';

export interface InternalTextLeakMatch {
  format: InternalTextFormat;
  sample: string;
}

export interface CollapseIntoDetailsInstruction {
  action: 'collapse_into_details';
  label: string;
  details: string;
}

export interface HumanizedInternalTextResult {
  text: string;
  detectedFormats: InternalTextFormat[];
  collapseIntoDetails?: CollapseIntoDetailsInstruction;
}

const UUID_EXACT_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_GLOBAL_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const SESSION_ID_EXACT_RE = /^(?:session_[A-Za-z0-9_-]{3,}|session-work-[A-Za-z0-9_-]{3,})$/;
const SESSION_ID_GLOBAL_RE = /\b(?:session_[A-Za-z0-9_-]{3,}|session-work-[A-Za-z0-9_-]{3,})\b/g;

const CALL_ID_EXACT_RE = /^(?:call_[A-Za-z0-9_-]{3,}|toolu_[A-Za-z0-9_-]{3,})$/;
const CALL_ID_GLOBAL_RE = /\b(?:call_[A-Za-z0-9_-]{3,}|toolu_[A-Za-z0-9_-]{3,})\b/g;

const OU_ID_EXACT_RE = /^(?:ou_[A-Za-z0-9_-]{3,}|oc_[A-Za-z0-9_-]{3,})$/;
const OU_ID_GLOBAL_RE = /\b(?:ou_[A-Za-z0-9_-]{3,}|oc_[A-Za-z0-9_-]{3,})\b/g;

const INTERNAL_TOOL_LABELS: Record<string, { zh: string; en: string }> = {
  read_file: { zh: '读取文件', en: 'Read file' },
  write_file: { zh: '写入文件', en: 'Write file' },
  edit_file: { zh: '编辑文件', en: 'Edit file' },
  list_directory: { zh: '查看目录', en: 'List directory' },
  web_fetch: { zh: '读取网页', en: 'Fetch web page' },
  todo_write: { zh: '更新待办清单', en: 'Update checklist' },
  spawn_agent: { zh: '启动协作助手', en: 'Start helper' },
  agent_message: { zh: '发送协作消息', en: 'Send helper message' },
  delegate_task: { zh: '委派子任务', en: 'Delegate subtask' },
  task_status: { zh: '查看任务进度', en: 'Check task status' },
  steer_task: { zh: '调整任务方向', en: 'Steer task' },
  cancel_task: { zh: '停止任务', en: 'Stop task' },
  memory_store: { zh: '保存记忆', en: 'Save memory' },
  memory_search: { zh: '检索记忆', en: 'Search memory' },
  tool_search: { zh: '查找可用工具', en: 'Find available tools' },
  computer_use: { zh: '操作桌面界面', en: 'Control desktop screen' },
  browser_action: { zh: '操作浏览器', en: 'Control browser' },
  plan_update: { zh: '更新执行计划', en: 'Update plan' },
  plan_read: { zh: '查看执行计划', en: 'Read plan' },
  findings_write: { zh: '记录关键发现', en: 'Record findings' },
  AskUserQuestion: { zh: '向你确认问题', en: 'Ask a clarifying question' },
  NotebookEdit: { zh: '编辑笔记本', en: 'Edit notebook' },
  MultiEdit: { zh: '批量编辑文件', en: 'Batch-edit files' },
  ToolSearch: { zh: '查找可用工具', en: 'Find available tools' },
  AgentSpawn: { zh: '启动协作助手', en: 'Start helper' },
  TaskManager: { zh: '管理后台任务', en: 'Manage background tasks' },
};

const INTERNAL_TOOL_NAMES_SORTED = Object.keys(INTERNAL_TOOL_LABELS).sort(
  (a, b) => b.length - a.length,
);

const INTERNAL_TOOL_GLOBAL_RE = new RegExp(
  `(?<![A-Za-z0-9_/-])(?:mcp__[A-Za-z0-9_-]+(?:__[A-Za-z0-9_-]+)*|${INTERNAL_TOOL_NAMES_SORTED.join('|')})(?![A-Za-z0-9_/-])`,
  'g',
);

interface EnglishStatePattern {
  regex: RegExp;
  replace: (match: string, lang: InternalTextLanguage, ...groups: string[]) => string;
}

const ENGLISH_STATE_PATTERNS: EnglishStatePattern[] = [
  {
    regex: /\baccepted\s*[：:]\s*/g,
    replace: (_match, lang) => (lang === 'en' ? 'Received: ' : '已接收：'),
  },
  {
    regex: /\[(running|completed|failed|cancelled|canceled|pending)\]\s*id=([A-Za-z0-9_-]+)/gi,
    replace: (_match, lang, state) => {
      const normalized = (state || '').toLowerCase();
      if (lang === 'en') {
        if (normalized === 'running') return 'Task running';
        if (normalized === 'completed') return 'Task completed';
        if (normalized === 'failed') return 'Task failed';
        if (normalized === 'cancelled' || normalized === 'canceled') return 'Task cancelled';
        return 'Task queued';
      }
      if (normalized === 'running') return '后台任务执行中';
      if (normalized === 'completed') return '后台任务已完成';
      if (normalized === 'failed') return '后台任务失败';
      if (normalized === 'cancelled' || normalized === 'canceled') return '后台任务已取消';
      return '后台任务等待中';
    },
  },
  {
    regex: /\binterrupted:\s*process crashed\b/gi,
    replace: (_match, lang) =>
      lang === 'en'
        ? 'Execution interrupted because the background process exited unexpectedly'
        : '执行中断：后台进程异常退出',
  },
  {
    regex: /\btool call was cancelled\b/gi,
    replace: (_match, lang) =>
      lang === 'en' ? 'Operation was cancelled' : '已取消本次操作',
  },
  {
    regex: /\bresult was recorded\b/gi,
    replace: (_match, lang) =>
      lang === 'en' ? 'Result saved' : '已记录执行结果',
  },
  {
    regex: /\bmail message\s*·\s*account\s+([^\s·]+)\s*·\s*mailbox\s+([^\s·\n]+)/gi,
    replace: (_match, lang, account, mailbox) =>
      lang === 'en'
        ? `Mail message (${account} / ${mailbox})`
        : `邮件消息（账号 ${account} · 邮箱 ${mailbox}）`,
  },
  {
    regex: /\bno outbound action attempted\b/gi,
    replace: (_match, lang) =>
      lang === 'en' ? 'No external message sent' : '未发送外部通知',
  },
  {
    regex: /\brun result carried no eventDecisions\b/gi,
    replace: (_match, lang) =>
      lang === 'en' ? 'No event handling records for this run' : '本次运行未产生事件处理记录',
  },
];

const SANDBOX_EXEC_COMMAND_RE = /\bsandbox-exec\s+-f\s+\S+/g;
const SANDBOX_EXEC_TOKEN_RE = /\bsandbox-exec\b/g;

const TEMP_PATH_GLOBAL_RE =
  /(?:\/private\/tmp|\/tmp|\/var\/folders)\/[A-Za-z0-9._/-]+/g;

const RAW_JSON_OBJECT_RE =
  /^\s*\{[\s\S]*"[^"\r\n]+"[\s]*:[\s\S]*\}\s*$/;
const INLINE_RAW_JSON_RE =
  /\{(?:\s*"[A-Za-z0-9_.-]+"\s*:\s*(?:"[^"]*"|-?\d+(?:\.\d+)?|true|false|null|\[[^\]]*\]|\{[^}]*\})\s*,?){1,}\}/g;

function humanizeMcpToolName(rawName: string, lang: InternalTextLanguage): string {
  const parts = rawName.replace(/^mcp__/, '').split('__').filter(Boolean);
  const tail = parts[parts.length - 1] || rawName;
  const readableTail = tail.replace(/[_-]+/g, ' ').trim();
  if (lang === 'en') {
    return readableTail ? `Plugin tool (${readableTail})` : 'Plugin tool';
  }
  return readableTail ? `插件工具（${readableTail}）` : '插件工具';
}

function humanizeToolToken(token: string, lang: InternalTextLanguage): string {
  const known = INTERNAL_TOOL_LABELS[token];
  if (known) {
    return known[lang];
  }
  if (token.startsWith('mcp__')) {
    return humanizeMcpToolName(token, lang);
  }
  return token;
}

function summarizeParsedJson(
  parsed: Record<string, unknown>,
  lang: InternalTextLanguage,
): string | null {
  const messageCandidate =
    typeof parsed.message === 'string'
      ? parsed.message
      : typeof parsed.error === 'string'
        ? parsed.error
        : typeof parsed.summary === 'string'
          ? parsed.summary
          : typeof parsed.reason === 'string'
            ? parsed.reason
            : null;
  if (messageCandidate?.trim()) {
    return messageCandidate.trim();
  }
  return lang === 'en'
    ? 'Structured details collapsed (expand Details to inspect)'
    : '结构化技术详情已折叠（展开「详情」可查看）';
}

/**
 * Inspect a user-visible string and return all internal-format leaks found.
 * Used both by the renderer humanizer and by the CI internal-text-leak gate.
 */
export function detectInternalTextLeaks(input: string): InternalTextLeakMatch[] {
  if (!input?.trim()) return [];

  const matches: InternalTextLeakMatch[] = [];
  const pushUnique = (format: InternalTextFormat, sample: string) => {
    if (!matches.some((m) => m.format === format)) {
      matches.push({ format, sample });
    }
  };

  const trimmed = input.trim();
  if (RAW_JSON_OBJECT_RE.test(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        pushUnique('raw_json', trimmed.slice(0, 80));
      }
    } catch {
      // If it still looks like a raw JSON object literal with key-value pairs
      if (INLINE_RAW_JSON_RE.test(trimmed)) {
        INLINE_RAW_JSON_RE.lastIndex = 0;
        pushUnique('raw_json', trimmed.slice(0, 80));
      }
    }
  } else {
    INLINE_RAW_JSON_RE.lastIndex = 0;
    const inlineJson = INLINE_RAW_JSON_RE.exec(input);
    if (inlineJson) {
      pushUnique('raw_json', inlineJson[0].slice(0, 80));
    }
  }

  UUID_GLOBAL_RE.lastIndex = 0;
  const uuidMatch = UUID_GLOBAL_RE.exec(input);
  if (uuidMatch) pushUnique('uuid', uuidMatch[0]);

  SESSION_ID_GLOBAL_RE.lastIndex = 0;
  const sessionMatch = SESSION_ID_GLOBAL_RE.exec(input);
  if (sessionMatch) pushUnique('session_id', sessionMatch[0]);

  CALL_ID_GLOBAL_RE.lastIndex = 0;
  const callMatch = CALL_ID_GLOBAL_RE.exec(input);
  if (callMatch) pushUnique('call_id', callMatch[0]);

  OU_ID_GLOBAL_RE.lastIndex = 0;
  const ouMatch = OU_ID_GLOBAL_RE.exec(input);
  if (ouMatch) pushUnique('ou_id', ouMatch[0]);

  INTERNAL_TOOL_GLOBAL_RE.lastIndex = 0;
  const toolMatch = INTERNAL_TOOL_GLOBAL_RE.exec(input);
  if (toolMatch) pushUnique('internal_tool_name', toolMatch[0]);

  for (const pattern of ENGLISH_STATE_PATTERNS) {
    pattern.regex.lastIndex = 0;
    const stateMatch = pattern.regex.exec(input);
    if (stateMatch) {
      pushUnique('english_state_word', stateMatch[0]);
      break;
    }
  }

  SANDBOX_EXEC_COMMAND_RE.lastIndex = 0;
  SANDBOX_EXEC_TOKEN_RE.lastIndex = 0;
  const sandboxMatch =
    SANDBOX_EXEC_COMMAND_RE.exec(input) || SANDBOX_EXEC_TOKEN_RE.exec(input);
  if (sandboxMatch) pushUnique('sandbox_exec', sandboxMatch[0]);

  TEMP_PATH_GLOBAL_RE.lastIndex = 0;
  const tempMatch = TEMP_PATH_GLOBAL_RE.exec(input);
  if (tempMatch) pushUnique('temp_path', tempMatch[0]);

  return matches;
}

/**
 * Convert internal runtime tokens, raw IDs, tool identifiers, sandbox commands,
 * temporary file paths, English state strings, or raw JSON into user-facing copy
 * (plus an optional `collapseIntoDetails` instruction when technical details belong
 * in a collapsible `<details>` block).
 *
 * Unknown / ordinary prose passes through unchanged.
 */
export function humanizeInternalText(
  input: string,
  lang: InternalTextLanguage = 'zh',
): HumanizedInternalTextResult {
  if (!input) {
    return { text: input, detectedFormats: [] };
  }

  const leaks = detectInternalTextLeaks(input);
  if (leaks.length === 0) {
    return { text: input, detectedFormats: [] };
  }

  const detectedFormats = leaks.map((l) => l.format);
  const detailsLabel = lang === 'en' ? 'Technical details' : '技术详情';
  const trimmed = input.trim();

  // Standalone exact IDs
  if (UUID_EXACT_RE.test(trimmed)) {
    return {
      text: lang === 'en' ? 'Internal record' : '内部记录',
      detectedFormats,
      collapseIntoDetails: {
        action: 'collapse_into_details',
        label: detailsLabel,
        details: trimmed,
      },
    };
  }

  if (SESSION_ID_EXACT_RE.test(trimmed)) {
    return {
      text: lang === 'en' ? 'Current session' : '当前会话',
      detectedFormats,
      collapseIntoDetails: {
        action: 'collapse_into_details',
        label: detailsLabel,
        details: trimmed,
      },
    };
  }

  if (CALL_ID_EXACT_RE.test(trimmed)) {
    return {
      text: lang === 'en' ? 'Tool operation' : '工具操作',
      detectedFormats,
      collapseIntoDetails: {
        action: 'collapse_into_details',
        label: detailsLabel,
        details: trimmed,
      },
    };
  }

  if (OU_ID_EXACT_RE.test(trimmed)) {
    return {
      text: lang === 'en' ? 'External contact' : '外部联系人',
      detectedFormats,
      collapseIntoDetails: {
        action: 'collapse_into_details',
        label: detailsLabel,
        details: trimmed,
      },
    };
  }

  // Standalone raw JSON object
  if (RAW_JSON_OBJECT_RE.test(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const summary = summarizeParsedJson(parsed as Record<string, unknown>, lang);
        const recursive = summary ? humanizeInternalText(summary, lang).text : '';
        return {
          text:
            recursive ||
            (lang === 'en'
              ? 'Structured details collapsed (expand Details to inspect)'
              : '结构化技术详情已折叠（展开「详情」可查看）'),
          detectedFormats,
          collapseIntoDetails: {
            action: 'collapse_into_details',
            label: detailsLabel,
            details: trimmed,
          },
        };
      }
    } catch {
      return {
        text:
          lang === 'en'
            ? 'Structured details collapsed (expand Details to inspect)'
            : '结构化技术详情已折叠（展开「详情」可查看）',
        detectedFormats,
        collapseIntoDetails: {
          action: 'collapse_into_details',
          label: detailsLabel,
          details: trimmed,
        },
      };
    }
  }

  let next = input;
  let shouldCollapseDetails = false;

  // 1. Replace English state phrases first (some include `id=...` or colons)
  for (const pattern of ENGLISH_STATE_PATTERNS) {
    next = next.replace(pattern.regex, (match, ...args) => {
      const groups = args.slice(0, -2) as string[];
      return pattern.replace(match, lang, ...groups);
    });
  }

  // 2. Replace sandbox-exec commands & tokens
  SANDBOX_EXEC_COMMAND_RE.lastIndex = 0;
  SANDBOX_EXEC_TOKEN_RE.lastIndex = 0;
  if (SANDBOX_EXEC_COMMAND_RE.test(next) || SANDBOX_EXEC_TOKEN_RE.test(next)) {
    shouldCollapseDetails = true;
    next = next.replace(SANDBOX_EXEC_COMMAND_RE, () =>
      lang === 'en' ? 'macOS system sandbox' : '系统安全沙箱',
    );
    next = next.replace(SANDBOX_EXEC_TOKEN_RE, () =>
      lang === 'en' ? 'macOS system sandbox' : '系统安全沙箱',
    );
  }

  // 3. Replace temp paths
  TEMP_PATH_GLOBAL_RE.lastIndex = 0;
  if (TEMP_PATH_GLOBAL_RE.test(next)) {
    shouldCollapseDetails = true;
    next = next.replace(TEMP_PATH_GLOBAL_RE, (fullPath) => {
      const segments = fullPath.split('/').filter(Boolean);
      const basename = segments[segments.length - 1] || '';
      const looksLikeRandomTemp =
        /^(?:tmp|var|folders|private)$/i.test(basename) ||
        /^[A-Za-z0-9_-]{12,}$/.test(basename);
      if (looksLikeRandomTemp || !basename.includes('.')) {
        return lang === 'en' ? 'temporary workspace file' : '临时工作文件';
      }
      return lang === 'en'
        ? `temporary file (${basename})`
        : `临时文件（${basename}）`;
    });
  }

  // 4. Replace inline raw JSON snippets
  INLINE_RAW_JSON_RE.lastIndex = 0;
  if (INLINE_RAW_JSON_RE.test(next)) {
    shouldCollapseDetails = true;
    next = next.replace(INLINE_RAW_JSON_RE, () =>
      lang === 'en' ? '(structured details)' : '（结构化详情）',
    );
  }

  // 5. Replace internal tool names
  next = next.replace(INTERNAL_TOOL_GLOBAL_RE, (token) =>
    humanizeToolToken(token, lang),
  );

  // 6. Replace UUIDs, session_ids, call_ids, ou_ids in mixed text
  UUID_GLOBAL_RE.lastIndex = 0;
  SESSION_ID_GLOBAL_RE.lastIndex = 0;
  CALL_ID_GLOBAL_RE.lastIndex = 0;
  OU_ID_GLOBAL_RE.lastIndex = 0;
  if (
    UUID_GLOBAL_RE.test(next) ||
    SESSION_ID_GLOBAL_RE.test(next) ||
    CALL_ID_GLOBAL_RE.test(next) ||
    OU_ID_GLOBAL_RE.test(next)
  ) {
    shouldCollapseDetails = true;
    next = next.replace(UUID_GLOBAL_RE, () =>
      lang === 'en' ? 'internal record' : '内部记录',
    );
    next = next.replace(SESSION_ID_GLOBAL_RE, () =>
      lang === 'en' ? 'current session' : '当前会话',
    );
    next = next.replace(CALL_ID_GLOBAL_RE, () =>
      lang === 'en' ? 'tool operation' : '工具操作',
    );
    next = next.replace(OU_ID_GLOBAL_RE, () =>
      lang === 'en' ? 'external contact' : '外部联系人',
    );
  }

  return {
    text: next,
    detectedFormats,
    ...(shouldCollapseDetails
      ? {
          collapseIntoDetails: {
            action: 'collapse_into_details',
            label: detailsLabel,
            details: input,
          },
        }
      : {}),
  };
}
