// ============================================================================
// 腾讯会议录制只读工具（N-MEETING-PAGE）：tmeetRecordList / tmeetRecordRead
//
// 走 Neo 内置的官方 tmeet CLI（连接器装在 <数据目录>/tmeet，登录态同腾讯会议连接器），
// 不另配 MCP 令牌。命令与返回形状 11-15 在 Dev 包里用真实账号跑过：
//   record list         → data.record_meetings[].record_files[].record_file_id
//   record transcript-get → data.minutes.paragraphs[]（speaker.user_name、start_time「00:16」），data.more 分页，下一页从 pid+1 起
//   record smart-minutes  → data.meeting_minute.minute（整段纪要文字）、todos
// 解析函数导出给会议页导入（PR3）复用。
// ============================================================================

import type { CanUseToolFn, ToolContext, ToolHandler, ToolModule, ToolResult } from '../../../protocol/tools';
import type { ToolSchema } from '../../../protocol/tools';
import { MEETING_SESSION_LIMITS } from '../../../../shared/constants';
import { executeTmeetCommand } from './tmeetToolCli';
import { tmeetRecordListSchema } from './tmeetRecordList.schema';
import { tmeetRecordReadSchema } from './tmeetRecordRead.schema';

type Exec = (args: string[], label: string) => Promise<string>;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function parseData(raw: string, what: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (error) {
    throw new Error(`tmeet ${what} returned invalid JSON`, { cause: error });
  }
  return obj(obj(v).data);
}

/** 「00:16」「1:02:03」→ 秒 */
export function clockToSeconds(clock: string): number {
  return clock.split(':').map(Number).reduce((acc, n) => acc * 60 + (Number.isFinite(n) ? n : 0), 0);
}

export function buildRecordListArgs(args: Record<string, unknown>): string[] {
  const out = ['record', 'list'];
  const start = str(args.start), end = str(args.end), id = str(args.meeting_id), code = str(args.meeting_code);
  if (code && !/^\d+$/.test(code)) throw new Error('meeting_code must contain digits only');
  if (!id && !code && !(start && end)) throw new Error('give start + end, or meeting_id, or meeting_code');
  if (start) out.push(`--start=${start}`);
  if (end) out.push(`--end=${end}`);
  if (id) out.push(`--meeting-id=${id}`);
  if (code) out.push(`--meeting-code=${code}`);
  if (str(args.page_token)) out.push(`--page-token=${str(args.page_token)}`);
  out.push('--format', 'json');
  return out;
}

export function formatRecordList(data: Record<string, unknown>): string {
  const meetings = arr(data.record_meetings).map(obj);
  if (!meetings.length) return '这个时间段没有腾讯会议录制或文字转写。';
  const lines = meetings.map((m) => {
    const files = arr(m.record_files).map(obj);
    const fileText = files.length
      ? files.map((f) => `record_file_id ${str(f.record_file_id)}（${str(f.record_start_time)} ~ ${str(f.record_end_time)}）`).join('；')
      : '没有可查看的录制文件（可能是别人主持、你没有查看权限）';
    return `- ${str(m.subject)} · meeting_id ${str(m.meeting_id)} · ${str(m.media_start_time)} · ${str(m.record_type)}\n  ${fileText}`;
  });
  const next = data.has_more === true && str(data.next_page_token) ? `\n还有更多，page_token: ${str(data.next_page_token)}` : '';
  return lines.join('\n') + next;
}

export interface TmeetTranscriptLine { offsetSec: number; speaker: string; text: string }

/** 逐页拉转写，装满字数预算或到页数上限为止 */
export async function fetchTmeetTranscript(
  exec: Exec,
  recordFileId: string,
  meetingId: string | undefined,
  maxChars: number = MEETING_SESSION_LIMITS.RECORDS_READ_MAX_CHARS,
): Promise<{ lines: TmeetTranscriptLine[]; truncated: boolean }> {
  const lines: TmeetTranscriptLine[] = [];
  let used = 0;
  let pid = '0';
  for (let page = 0; page < MEETING_SESSION_LIMITS.IMPORT_MAX_PAGES; page++) {
    // 模型给的值一律 --flag=value：以 - 开头的值不会被 CLI 当成选项
    const args = ['record', 'transcript-get', `--record-file-id=${recordFileId}`, `--pid=${pid}`, '--limit=100', '--format', 'json'];
    if (meetingId) args.push(`--meeting-id=${meetingId}`);
    const data = parseData(await exec(args, 'tmeet record transcript-get'), 'transcript-get');
    const paragraphs = arr(obj(data.minutes).paragraphs).map(obj);
    for (const p of paragraphs) {
      const text = arr(p.sentences).map(obj).flatMap((s) => arr(s.words).map((w) => str(obj(w).text))).join('');
      if (!text) continue;
      if (used + text.length > maxChars) return { lines, truncated: true };
      lines.push({ offsetSec: clockToSeconds(str(p.start_time)), speaker: str(obj(p.speaker).user_name), text });
      used += text.length;
    }
    const last = paragraphs.at(-1);
    if (data.more !== true || !last) return { lines, truncated: false };
    pid = String(Number(str(last.pid)) + 1);
  }
  return { lines, truncated: true };
}

export async function fetchTmeetSmartMinutes(exec: Exec, recordFileId: string): Promise<{ minute: string; todos: string[] }> {
  const data = parseData(await exec(['record', 'smart-minutes', `--record-file-id=${recordFileId}`, '--format', 'json'], 'tmeet record smart-minutes'), 'smart-minutes');
  const mm = obj(data.meeting_minute);
  // todo 实测是空字符串，todos 是 [{content:'-   事项 @某人', executor_list}]
  const todos = arr(mm.todos).map((t) => str(obj(t).content).replace(/^[-\s]+/, '')).filter(Boolean);
  return { minute: str(mm.minute), todos };
}

const fmtOffset = (sec: number) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

/** 没连接 / 没登录时给用户能照做的话，不只丢一句 CLI 原文 */
export function friendlyTmeetError(error: unknown): string {
  const e = error as { message?: string; stdout?: string; stderr?: string };
  const all = `${e?.message ?? ''}\n${e?.stdout ?? ''}\n${e?.stderr ?? ''}`;
  if (/not logged in|user config is empty/i.test(all)) return '腾讯会议还没连接：请在 设置 → 连接器 → 腾讯会议 连接一次。';
  return `腾讯会议读取失败：${(e?.message ?? String(error)).slice(-300)}`;
}

async function guard(schema: ToolSchema, args: Record<string, unknown>, ctx: ToolContext, canUseTool: CanUseToolFn): Promise<ToolResult<string> | null> {
  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  if (ctx.abortSignal.aborted) return { ok: false, error: 'aborted', code: 'ABORTED' };
  return null;
}

export async function runTmeetRecordList(exec: Exec, args: Record<string, unknown>): Promise<ToolResult<string>> {
  let cli: string[];
  try {
    cli = buildRecordListArgs(args);
  } catch (error) {
    return { ok: false, error: (error as Error).message, code: 'INVALID_ARGS' };
  }
  try {
    return { ok: true, output: formatRecordList(parseData(await exec(cli, 'tmeet record list'), 'record list')) };
  } catch (error) {
    return { ok: false, error: friendlyTmeetError(error) };
  }
}

export async function runTmeetRecordRead(exec: Exec, args: Record<string, unknown>): Promise<ToolResult<string>> {
  const recordFileId = str(args.record_file_id);
  if (!recordFileId) return { ok: false, error: 'record_file_id is required', code: 'INVALID_ARGS' };
  const parts: string[] = [];
  try {
    if (args.include_minutes !== false) {
      const { minute, todos } = await fetchTmeetSmartMinutes(exec, recordFileId);
      parts.push(`## 腾讯会议智能纪要（腾讯会议 AI 生成，不是原话）\n${minute || '（这场会没有智能纪要）'}${todos.length ? `\n\n腾讯会议 AI 列的待办（@ 后的负责人是它自动判断的，以转写原话为准）：\n${todos.map((t) => `- ${t}`).join('\n')}` : ''}`);
    }
    if (args.include_transcript !== false) {
      const { lines, truncated } = await fetchTmeetTranscript(exec, recordFileId, str(args.meeting_id) || undefined);
      const body = lines.map((l) => `[${fmtOffset(l.offsetSec)}${l.speaker ? ` ${l.speaker}` : ''}] ${l.text}`).join('\n');
      parts.push(`## 转写${truncated ? '（太长，后面部分已省略）' : ''}（时刻相对录制开始）\n${body || '（没有转写内容）'}`);
    }
  } catch (error) {
    return { ok: false, error: friendlyTmeetError(error) };
  }
  return { ok: true, output: parts.join('\n\n') };
}

const tmeetExec: Exec = (args, label) => executeTmeetCommand(args, label);

class TmeetRecordListHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = tmeetRecordListSchema;
  async execute(args: Record<string, unknown>, ctx: ToolContext, canUseTool: CanUseToolFn): Promise<ToolResult<string>> {
    return (await guard(this.schema, args, ctx, canUseTool)) ?? runTmeetRecordList(tmeetExec, args);
  }
}

class TmeetRecordReadHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = tmeetRecordReadSchema;
  async execute(args: Record<string, unknown>, ctx: ToolContext, canUseTool: CanUseToolFn): Promise<ToolResult<string>> {
    return (await guard(this.schema, args, ctx, canUseTool)) ?? runTmeetRecordRead(tmeetExec, args);
  }
}

export const tmeetRecordListModule: ToolModule<Record<string, unknown>, string> = {
  schema: tmeetRecordListSchema,
  createHandler: () => new TmeetRecordListHandler(),
};

export const tmeetRecordReadModule: ToolModule<Record<string, unknown>, string> = {
  schema: tmeetRecordReadSchema,
  createHandler: () => new TmeetRecordReadHandler(),
};
