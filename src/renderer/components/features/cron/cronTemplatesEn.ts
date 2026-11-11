// ============================================================================
// Cron 模板 en 档的 agent 提示词（N-FIX-TITLE-LANG-FOLLOWS-UI-FU1）
// ============================================================================
// 手写英文版（方案 A1）：不用模型翻译——非确定性会改写契约标记。与中文版逐段对译，
// 以下字节必须与中文版/host 注入完全一致，不许翻译：
//   - <cron_snapshot>…</cron_snapshot> / <cron_alert>…</cron_alert> 标签；
//   - 工具与字段名：mail_send、mail_draft、calendar_create_event、calendar_update_event、
//     calendar_delete_event、appTableRecord.search、start_time、end_time、app_token、
//     table_id、record_id；
//   - host 注入的时间锚标签「今天本地 00:00」「次日本地 00:00」（cronAgentPrompt.ts
//     注入的中文标签本身，英文任务照抄这两个值）；
//   - 晨间分诊契约行：块头 "Draft N (not sent)"、失败腿 "Not read: <source>"、
//     空结论 "Nothing needs attention this morning"、回复指令 save draft N
//     （sessionCommandCenterBrain 的 SAVE_DRAFT_REPLY_RE 与晨报解析块认这些写法）。
// 本文件只进 en 档；zh 输出与 cronTemplates.ts 内的中文原文逐字节相同。
// ============================================================================

/** 晨间分诊未绑定角色时的提示词（en）。结构与中文 MORNING_TRIAGE_BASE_PROMPT 逐段对应。 */
const MORNING_TRIAGE_BASE_PROMPT_EN =
  'Please give me a morning triage of my unread email, instant messages, and calendar changes since last night. ' +
  'First take stock of the connections I currently have (mail, IM, calendar) and use whatever is available. ' +
  'Sort the items worth attention into three tiers — "Must handle today" / "Can wait" / "Just so you know" — with at most 5 items per tier, picking the most important ones; for each item, one sentence on what it is and why it belongs in that tier. ' +
  'If there is nothing to handle or worth knowing this morning, say so plainly as "Nothing needs attention this morning"; do not pad with filler items and do not produce an empty list. ' +
  'Sources that are connected but failed to read this run (mail/IM/calendar) must each be named in the output as "Not read: <source>"; a read failure must never be reported as "Nothing needs attention this morning". ' +
  'If there are no mail/IM/calendar connections at all, do not report an error: state in the output which connections are missing and what each would add, and suggest that I connect them in Settings.';

/** 绑了角色才追加的起草规则（en）。块头/回复指令是契约行，见文件头注。 */
const MORNING_TRIAGE_DRAFTING_BLOCK_EN =
  'Draft replies only for emails in "Must handle today" that need a reply, at most 3; do not draft for the other tiers. ' +
  'Each draft is its own block, and the first line of the block must be "Draft N (not sent)", numbering N as 1, 2, 3 in order. ' +
  'The second line contains only the recipient email address; separate multiple addresses with commas — no display names, no angle brackets, and no "To" prefix. ' +
  'The third line is only the subject, without the word "Subject". From the fourth line until the next block is the body; do not write the word "Body" there; write the body in the language of the sender\'s email, with a tone that follows the injected role memory. ' +
  'Mark the source at the end of every item: for email, "(source: sender · subject)"; for calendar events, "(source: event title · time)". ' +
  'Compare today\'s calendar events pairwise and name every overlapping pair — for example, when a call lands mid-flight, write "Schedule conflict: the 14:00 call overlaps the 13:30 flight (source: calendar)". ' +
  'Do not call mail_send or mail_draft, do not call calendar_create_event, calendar_update_event, calendar_delete_event, or any tool that would create, modify, or delete calendar events; drafts live only in this morning brief and must not be sent out. ' +
  'On a final line of its own, tell the user: to file one of these into the mailbox, reply "save draft N" in this conversation, where N is the draft number.';

function morningTriagePromptEn(values: Record<string, string>): string {
  const roleId = values?.roleId?.trim() ?? '';
  return roleId
    ? `${MORNING_TRIAGE_BASE_PROMPT_EN}\n${MORNING_TRIAGE_DRAFTING_BLOCK_EN}`
    : MORNING_TRIAGE_BASE_PROMPT_EN;
}

/** host 注入的时间锚标签（cronAgentPrompt.ts 原文，不翻译——见文件头注）。 */
const TODAY_MIDNIGHT_LABEL = '今天本地 00:00';
const TOMORROW_MIDNIGHT_LABEL = '次日本地 00:00';

/** en 档提示词表；带用户输入的模板用构造器。 */
const EN_AGENT_PROMPTS: Record<string, string | ((values: Record<string, string>) => string)> = {
  'daily-lookahead':
    'Please organize my schedule, to-dos, and priorities for the rest of today and tomorrow. ' +
    'Flag time conflicts, approaching deadlines, and anything I should prepare for or follow up on ahead of time.',
  'daily-review':
    'Please review my work today: organize what was completed, what was not, and what needs continued follow-up; ' +
    'point out blockers, risks, and what should be pushed first tomorrow.',
  'weekly-review':
    'Please summarize my main progress, key results, unfinished items, and risks this week, and, building on my existing schedule and to-dos, ' +
    'lay out next week\'s priorities, what needs preparing, and in what order.',
  'morning-triage': morningTriagePromptEn,
  'web-change-watch': (v) =>
    `Please check whether the content at ${v.url} has changed, paying special attention to new content, important changes, and information I should know about. ` +
    'If something changed, briefly explain what changed and why it is worth attention; if nothing changed, tell me that directly.',
  'feishu-calendar-conflict': (v) =>
    `Use the Feishu calendar tools to check today's events on calendar ${v.calendarId}. ` +
    `For start_time copy the Unix seconds given above for the "${TODAY_MIDNIGHT_LABEL}" anchor, and for end_time those for the "${TOMORROW_MIDNIGHT_LABEL}" anchor — copy them verbatim, do not convert them yourself; ` +
    'the page size must be at least 50 (50 is the floor of the Feishu calendar API; smaller values error out). ' +
    'Compare the events pairwise for time overlaps. ' +
    'Wrap a short signature of all current conflict pairs (the two event titles plus times) in <cron_snapshot>…</cron_snapshot> for the next comparison. ' +
    'Only when a conflict is new since the last run should you wrap an explanation of that new conflict (who and who, which times collide) in <cron_alert>…</cron_alert>; ' +
    'if there are no new conflicts, do not output <cron_alert> — just say in one line that there are no new conflicts this run.',
  'feishu-table-change': (v) =>
    `Use the Feishu base record search tool (appTableRecord.search, app_token=${v.baseAppToken}, table_id=${v.tableId}) to fetch the current records. ` +
    'Build a short fingerprint for each record from its record_id and field contents (a digest of the field contents for that record_id). ' +
    'Wrap the fingerprints of all records in <cron_snapshot>…</cron_snapshot> for the next comparison. ' +
    'Compare with the last snapshot and identify rows that were added and rows whose fields changed. ' +
    'Only when there really are additions or changes should you wrap a change note (which rows, what changed) in <cron_alert>…</cron_alert>; ' +
    'if there are none, do not output <cron_alert> — just say in one line that nothing changed this run.',
};

/**
 * en 档的 agent 提示词。没有英文版的模板返回 undefined：
 * group-listen 的 agentPrompt 就是用户填的一句话任务，原样保留。
 *
 * 尾部统一加一句显式的输出语言指令：en 提示词跑在中文 host 包装（cronAgentPrompt
 * 的时间锚/摘要指令）与中文语料中间，真机实测（2026-11-11 MiMo）不加这句时英文
 * 提示词也会漂成中文回复；加了才稳定出英文。zh 档不加对应句（中文本就是缺省）。
 */
const EN_OUTPUT_LANGUAGE_SUFFIX = ' Write your reply in English.';

export function enAgentPrompt(templateId: string, values: Record<string, string> = {}): string | undefined {
  const entry = EN_AGENT_PROMPTS[templateId];
  if (!entry) return undefined;
  const prompt = typeof entry === 'function' ? entry(values) : entry;
  return `${prompt}${EN_OUTPUT_LANGUAGE_SUFFIX}`;
}
