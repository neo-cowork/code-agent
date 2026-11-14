import type {
  CanUseToolFn,
  ToolContext,
  ToolHandler,
  ToolModule,
  ToolResult,
} from '../../../protocol/tools';
import { MEETING_SESSION_LIMITS } from '../../../../shared/constants';
import type { MeetingMinutes, MeetingSummaryRecord } from '../../../../shared/contract/audioCapture';
import { formatTranscript, getMeetingRecordStore, type MeetingRecordStore } from '../../../services/desktop/meetingRecords';
import { meetingRecordsSchema as schema } from './meetingRecords.schema';

const SOURCE_LABEL: Record<MeetingSummaryRecord['source'], string> = { recorded: '本机录音', feishu: '飞书妙记', tmeet: '腾讯会议' };
const MINUTES_LABEL: Record<string, string> = { pending: '等待出纪要', running: '出纪要中', done: '已出纪要', failed: '纪要失败', skipped: '没出纪要' };

const fmtTime = (ms: number) => new Date(ms).toLocaleString('zh-CN', { hour12: false });

function headline(m: MeetingSummaryRecord): string {
  const end = m.endedAtMs ? ` ~ ${new Date(m.endedAtMs).toTimeString().slice(0, 5)}` : (m.state === 'ended' ? '' : '（进行中）');
  return `- ${m.title}（id: ${m.id}）${fmtTime(m.startedAtMs)}${end} · ${SOURCE_LABEL[m.source]} · ${m.minutesState ? MINUTES_LABEL[m.minutesState] : '没出纪要'}`;
}

function formatMinutes(min: MeetingMinutes): string {
  const block = (title: string, items: string[]) => (items.length ? `### ${title}\n${items.join('\n')}` : `### ${title}\n（无）`);
  return [
    block('决策', min.decisions.map((d) => `- ${d.text}（原话：${d.quote}）`)),
    block('行动项', min.actionItems.map((a) => `- ${a.text} · 负责人：${a.owner ?? '待认领'} · 截止：${a.due ?? '待定'}（原话：${a.quote}）`)),
    block('未解问题', min.openQuestions.map((o) => `- ${o.text}（原话：${o.quote}）`)),
  ].join('\n');
}

function clampLimit(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 10;
  return Math.min(Math.max(n, 1), MEETING_SESSION_LIMITS.RECORDS_SEARCH_LIMIT);
}

export function runMeetingRecords(store: MeetingRecordStore, args: Record<string, unknown>): ToolResult<string> {
  const action = args.action ?? 'list';
  if (action === 'list') {
    const list = store.list(clampLimit(args.limit));
    return { ok: true, output: list.length ? list.map(headline).join('\n') : '还没有会议记录。' };
  }
  if (action === 'search') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) return { ok: false, error: 'search needs query', code: 'INVALID_ARGS' };
    const hits = store.search(query, clampLimit(args.limit));
    if (!hits.length) return { ok: true, output: `没有找到含「${query}」的会议。` };
    return {
      ok: true,
      output: hits.map((h) => `${headline(h.meeting)}\n  ${h.atMs ? `[${new Date(h.atMs).toTimeString().slice(0, 5)}] ` : ''}${h.snippet}`).join('\n'),
    };
  }
  if (action === 'read') {
    const id = typeof args.meeting_id === 'string' ? args.meeting_id.trim() : '';
    if (!id) return { ok: false, error: 'read needs meeting_id', code: 'INVALID_ARGS' };
    const meeting = store.get(id);
    if (!meeting) return { ok: false, error: `no meeting with id ${id}`, code: 'NOT_FOUND' };
    const { text, truncated } = formatTranscript(store.transcript(meeting));
    return {
      ok: true,
      output: [
        `# ${meeting.title}`,
        headline(meeting),
        meeting.minutes ? `## 纪要\n${formatMinutes(meeting.minutes)}` : '## 纪要\n还没有纪要。',
        `## 转写${truncated ? '（太长，后面部分已省略）' : ''}\n${text || '这场会没有转写出内容。'}`,
      ].join('\n\n'),
    };
  }
  return { ok: false, error: 'action must be list, search or read', code: 'INVALID_ARGS' };
}

class MeetingRecordsHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(args: Record<string, unknown>, ctx: ToolContext, canUseTool: CanUseToolFn): Promise<ToolResult<string>> {
    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    if (ctx.abortSignal.aborted) return { ok: false, error: 'aborted', code: 'ABORTED' };
    return runMeetingRecords(await getMeetingRecordStore(), args);
  }
}

export const meetingRecordsModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new MeetingRecordsHandler();
  },
};
