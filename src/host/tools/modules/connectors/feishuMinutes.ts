// ============================================================================
// 飞书妙记只读工具（N-MEETING-PAGE）：feishuMinutesSearch / feishuMinutesRead
//
// 走飞书连接器的 lark-cli（Neo 装在 <数据目录>/lark-cli，配置名 neo，要显式带 --profile），
// 授权范围含妙记只读五项（cliConnectorDescriptors.ts）。11-15 在 Dev 包里用真实账号跑过：
//   minutes +search → data.items[]（token、display_info 首行是标题、meta_data.description 含开始时间与时长）
//   minutes +detail --transcript --summary --todo → stdout JSON（artifacts.summary / todos），
//     转写写成 <cwd>/artifact-<标题>-<token>/transcript.txt：首行「YYYY-MM-DD HH:MM:SS CST|时长」，
//     之后「Speaker 1 00:00:00.520」一行、正文若干行。输出目录只收当前目录下的相对路径，所以在临时目录里跑。
// 解析函数导出给会议页导入（PR3）复用。
// ============================================================================

import * as fs from 'fs/promises';
import os from 'os';
import * as path from 'path';
import type { CanUseToolFn, ToolContext, ToolHandler, ToolModule, ToolResult } from '../../../protocol/tools';
import { MEETING_SESSION_LIMITS } from '../../../../shared/constants';
import { feishuCliDescriptor } from '../../../../shared/constants/cliConnectorDescriptors';
import { createLarkCliDriver } from '../../../connectors/feishu/larkCli';
import { feishuMinutesSearchSchema } from './feishuMinutesSearch.schema';
import { feishuMinutesReadSchema } from './feishuMinutesRead.schema';

export type LarkExec = (args: string[], label: string, cwd?: string) => Promise<string>;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** lark-cli 输出 JSON 前可能夹着 [WARN] 行，从第一个 { 起解析 */
function parseLarkJson(raw: string, what: string): Record<string, unknown> {
  const i = raw.indexOf('{');
  try {
    return obj(JSON.parse(i >= 0 ? raw.slice(i) : raw));
  } catch (error) {
    throw new Error(`lark-cli ${what} returned invalid JSON`, { cause: error });
  }
}

/** 妙记 token，或 https://xxx.feishu.cn/minutes/<token> */
export function minuteTokenOf(input: string): string | null {
  const s = input.trim();
  const fromUrl = s.match(/\/minutes\/([A-Za-z0-9]+)/);
  if (fromUrl) return fromUrl[1];
  return /^[A-Za-z0-9]+$/.test(s) ? s : null;
}

export interface FeishuMinuteHit { token: string; title: string; description: string; url: string }

export function parseMinutesSearch(stdout: string): { hits: FeishuMinuteHit[]; pageToken: string | null } {
  const data = obj(parseLarkJson(stdout, 'minutes +search').data);
  const hits = arr(data.items).map(obj).map((x) => ({
    token: str(x.token),
    title: str(x.display_info).split('\n')[0] ?? '',
    description: str(obj(x.meta_data).description),
    url: str(obj(x.meta_data).app_link),
  })).filter((h) => h.token);
  return { hits, pageToken: data.has_more === true && str(data.page_token) ? str(data.page_token) : null };
}

const HEAD = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/;
const SENT = /^(.+?) (\d+):(\d\d):(\d\d)(?:\.\d+)?\s*$/;

export interface FeishuTranscriptLine { offsetSec: number; speaker: string; text: string }

/** transcript.txt → 逐句；startedAtMs 是首行的开始时刻（解析不到为 null） */
export function parseFeishuTranscript(text: string): { startedAtMs: number | null; lines: FeishuTranscriptLine[] } {
  const all = text.split(/\r?\n/);
  const head = HEAD.exec(all[0] ?? '');
  const startedAtMs = head ? new Date(head[1].replace(' ', 'T') + '+08:00').getTime() : null;
  const lines: FeishuTranscriptLine[] = [];
  for (const line of all.slice(1)) {
    const s = SENT.exec(line);
    if (s) lines.push({ offsetSec: Number(s[2]) * 3600 + Number(s[3]) * 60 + Number(s[4]), speaker: s[1].trim(), text: '' });
    else if (lines.length && line.trim()) lines[lines.length - 1].text += line.trim();
  }
  return { startedAtMs, lines: lines.filter((l) => l.text) };
}

export interface FeishuMinuteDetail {
  title: string;
  summary: string;
  todos: string[];
  startedAtMs: number | null;
  lines: FeishuTranscriptLine[];
}

export async function fetchFeishuMinute(exec: LarkExec, token: string): Promise<FeishuMinuteDetail> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-feishu-minute-'));
  try {
    const stdout = await exec(['minutes', '+detail', '--as', 'user', '--minute-tokens', token, '--transcript', '--summary', '--todo', '--overwrite', '--output-dir', '.', '--format', 'json'], 'lark-cli minutes +detail', dir);
    const minute = obj(arr(obj(parseLarkJson(stdout, 'minutes +detail').data).minutes)[0]);
    const artifacts = obj(minute.artifacts);
    const todos = arr(artifacts.todos).map((t) => (typeof t === 'string' ? t : str(obj(t).content) || str(obj(t).text))).filter(Boolean);
    const entries = await fs.readdir(dir, { recursive: true });
    const rel = entries.find((e) => path.basename(String(e)) === 'transcript.txt');
    const parsed = rel ? parseFeishuTranscript(await fs.readFile(path.join(dir, String(rel)), 'utf-8')) : { startedAtMs: null, lines: [] };
    return { title: str(minute.title), summary: str(artifacts.summary), todos, ...parsed };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 没连接 / 老用户缺妙记权限时给能照做的话，不套用连接时那句「联系管理员」 */
export function friendlyLarkError(error: unknown): string {
  const e = error as { message?: string; stdout?: string; stderr?: string };
  const all = `${e?.message ?? ''}\n${e?.stdout ?? ''}\n${e?.stderr ?? ''}`;
  if (/not_configured|profile\s+\S+\s+not found|not configured|no logged-in user|not logged in/i.test(all)) {
    return '飞书还没连接：请在 设置 → 连接器 → 飞书 连接一次。';
  }
  if (/scope|permission|unauthori[sz]ed|99991679|权限|未授权/i.test(all)) {
    return '飞书还没授权读取妙记：请在 设置 → 连接器 → 飞书 断开后重新连接一次，会多申请妙记只读权限。';
  }
  return `飞书妙记读取失败：${(e?.message ?? String(error)).slice(-300)}`;
}

const fmtOffset = (sec: number) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

export async function runFeishuMinutesSearch(exec: LarkExec, args: Record<string, unknown>): Promise<ToolResult<string>> {
  const cli = ['minutes', '+search', '--as', 'user', '--format', 'json'];
  for (const [key, flag] of [['query', '--query'], ['start', '--start'], ['end', '--end'], ['page_token', '--page-token']] as const) {
    if (str(args[key])) cli.push(`${flag}=${str(args[key])}`); // --flag=value：以 - 开头的值不会被当成选项
  }
  if (args.page_size !== undefined) {
    const n = Number(args.page_size);
    if (!Number.isInteger(n) || n < 1 || n > 30) return { ok: false, error: 'page_size must be an integer from 1 to 30', code: 'INVALID_ARGS' };
    cli.push(`--page-size=${n}`);
  }
  try {
    const { hits, pageToken } = parseMinutesSearch(await exec(cli, 'lark-cli minutes +search'));
    if (!hits.length) return { ok: true, output: '没有找到符合条件的飞书妙记。' };
    const body = hits.map((h) => `- ${h.title} · token ${h.token} · ${h.description}`).join('\n');
    return { ok: true, output: body + (pageToken ? `\n还有更多，page_token: ${pageToken}` : '') };
  } catch (error) {
    return { ok: false, error: friendlyLarkError(error) };
  }
}

export async function runFeishuMinutesRead(exec: LarkExec, args: Record<string, unknown>): Promise<ToolResult<string>> {
  const token = minuteTokenOf(str(args.minute));
  if (!token) return { ok: false, error: 'minute must be a minute token or a Feishu Minutes URL', code: 'INVALID_ARGS' };
  let d: FeishuMinuteDetail;
  try {
    d = await fetchFeishuMinute(exec, token);
  } catch (error) {
    return { ok: false, error: friendlyLarkError(error) };
  }
  const out: string[] = [];
  let used = 0;
  let truncated = false;
  for (const l of d.lines) {
    const s = `[${fmtOffset(l.offsetSec)} ${l.speaker}] ${l.text}`;
    if (used + s.length > MEETING_SESSION_LIMITS.RECORDS_READ_MAX_CHARS) { truncated = true; break; }
    out.push(s);
    used += s.length + 1;
  }
  const start = d.startedAtMs ? new Date(d.startedAtMs).toLocaleString('zh-CN', { hour12: false }) : '开始时间未知';
  return {
    ok: true,
    output: [
      `# ${d.title || token}（${start}）`,
      `## 飞书 AI 摘要（不是原话）\n${d.summary || '（没有摘要）'}`,
      d.todos.length ? `## 飞书 AI 列的待办（以转写原话为准）\n${d.todos.map((t) => `- ${t}`).join('\n')}` : '',
      `## 转写${truncated ? '（太长，后面部分已省略）' : ''}（时刻相对妙记开始）\n${out.join('\n') || '（没有转写内容）'}`,
    ].filter(Boolean).join('\n\n'),
  };
}

let driver: ReturnType<typeof createLarkCliDriver> | null = null;
const larkExec: LarkExec = async (args, label, cwd) => {
  driver ??= createLarkCliDriver();
  const result = await driver.execute([...args, ...(feishuCliDescriptor.profileArguments ?? [])], label, { cwd });
  return result.stdout;
};

class FeishuMinutesSearchHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = feishuMinutesSearchSchema;
  async execute(args: Record<string, unknown>, ctx: ToolContext, canUseTool: CanUseToolFn): Promise<ToolResult<string>> {
    const permit = await canUseTool(this.schema.name, args);
    if (!permit.allow) return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    if (ctx.abortSignal.aborted) return { ok: false, error: 'aborted', code: 'ABORTED' };
    return runFeishuMinutesSearch(larkExec, args);
  }
}

class FeishuMinutesReadHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = feishuMinutesReadSchema;
  async execute(args: Record<string, unknown>, ctx: ToolContext, canUseTool: CanUseToolFn): Promise<ToolResult<string>> {
    const permit = await canUseTool(this.schema.name, args);
    if (!permit.allow) return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    if (ctx.abortSignal.aborted) return { ok: false, error: 'aborted', code: 'ABORTED' };
    return runFeishuMinutesRead(larkExec, args);
  }
}

export const feishuMinutesSearchModule: ToolModule<Record<string, unknown>, string> = {
  schema: feishuMinutesSearchSchema,
  createHandler: () => new FeishuMinutesSearchHandler(),
};

export const feishuMinutesReadModule: ToolModule<Record<string, unknown>, string> = {
  schema: feishuMinutesReadSchema,
  createHandler: () => new FeishuMinutesReadHandler(),
};
