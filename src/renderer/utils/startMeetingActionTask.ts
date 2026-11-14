// ============================================================================
// startMeetingActionTask — 会议页行动项「交给 Neo」（N-MEETING-PAGE ③）
//
// 关掉资料库 → 新建会话 → 写入待发种子消息（ChatView 的 pendingRoleChatSeed 通道自动发出）。
// 爸 11-15 定：首句不能只有事项本身，要带会议名、这条事项的原话出处，再加一句「可用 meeting_records
// 查这场会」，新会话才有上下文。用户自己点的、可撤回，不加确认框。
// ============================================================================

import type { MeetingActionItem, MeetingSummaryRecord } from '@shared/contract/audioCapture';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';

const TITLE_MAX = 40;

function meetingDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function buildMeetingActionSeed(meeting: Pick<MeetingSummaryRecord, 'id' | 'title' | 'startedAtMs'>, item: MeetingActionItem): string {
  return [
    `会议「${meeting.title}」（${meetingDate(meeting.startedAtMs)}）上的一条行动项，请帮我推进：${item.text}`,
    `原话：「${item.quote}」`,
    `负责人：${item.owner ?? '会上没定'}；截止：${item.due ?? '会上没定'}`,
    `可用 meeting_records 查这场会（meeting_id: ${meeting.id}）。`,
  ].join('\n');
}

export async function startMeetingActionTask(meeting: MeetingSummaryRecord, item: MeetingActionItem): Promise<void> {
  const app = useAppStore.getState();
  app.setShowLibraryPanel(false);
  const title = item.text.length > TITLE_MAX ? `${item.text.slice(0, TITLE_MAX)}…` : item.text;
  const session = await useSessionStore.getState().createSession(title);
  if (!session) return;
  app.setPendingRoleChatSeed(buildMeetingActionSeed(meeting, item));
}
