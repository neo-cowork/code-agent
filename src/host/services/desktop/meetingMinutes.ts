// ============================================================================
// 会后自动纪要（N-MEETING-PAGE ②）：会议结束 / 导入后交给「记言」出决策、行动项、未解问题
//
// 状态：pending → running → done / failed；开关关着或转写太短直接 skipped（不调模型、不花钱）。
// 记言只拿 meeting_records 一个只读工具，按固定格式交回 ```meeting_minutes JSON```。
// 宿主再校验一遍（纪要编造缺陷 PR#3328 的同一道防线放到这里）：
//   - 每条的原话出处必须真在转写里，对不上的整条丢掉——纪要里不许有会上没说过的话；
//   - 负责人 / 截止时间只有原话里写了才留，否则置空，界面显示「待认领 / 待定」，只列不派。
// 串行：同一时刻只跑一场，后来的排队。状态机见 docs/architecture/meeting-session.md。
// ============================================================================

import { MEETING_SESSION_LIMITS, ROLE_PROACTIVITY } from '../../../shared/constants';
import type {
  MeetingActionItem,
  MeetingMinutes,
  MeetingMinutesItem,
  MeetingSummaryRecord,
} from '../../../shared/contract/audioCapture';
import { createLogger } from '../infra/logger';
import type { MeetingRecordStore } from './meetingRecords';

const logger = createLogger('MeetingMinutes');

export const MINUTES_ROLE_ID = '记言';
const BLOCK_PATTERN = /```meeting_minutes\s*([\s\S]*?)```/i;

/** 去掉空白和标点再比，ASR 断句、全半角标点不同不算对不上 */
const norm = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export interface MinutesValidation {
  minutes: MeetingMinutes;
  /** 原话出处在转写里找不到、被丢掉的条数 */
  dropped: number;
  /** 负责人 / 截止时间原话里没写、被置空的次数 */
  cleared: number;
}

/** 解析记言的输出并逐条核对原话；没有纪要块或不是 JSON 返回 null */
export function validateMinutes(output: string, transcript: string): MinutesValidation | null {
  const block = BLOCK_PATTERN.exec(output)?.[1];
  if (!block) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(block) as Record<string, unknown>;
  } catch {
    return null;
  }
  const source = norm(transcript);
  let dropped = 0;
  let cleared = 0;
  const pick = (key: string): Array<Record<string, unknown>> => (Array.isArray(raw[key]) ? raw[key] as Array<Record<string, unknown>> : [])
    .slice(0, MEETING_SESSION_LIMITS.MINUTES_MAX_ITEMS_PER_KIND);
  const grounded = (item: Record<string, unknown>): MeetingMinutesItem | null => {
    const text = str(item.text);
    const quote = str(item.quote);
    if (!text || !quote || !source.includes(norm(quote))) {
      dropped += 1;
      return null;
    }
    return { text, quote };
  };
  const statedIn = (value: unknown, quote: string): string | null => {
    const v = str(value);
    if (!v) return null;
    if (norm(quote).includes(norm(v))) return v;
    cleared += 1;
    return null;
  };
  const items = (key: string) => pick(key).map(grounded).filter((x): x is MeetingMinutesItem => x !== null);
  const actionItems: MeetingActionItem[] = pick('actionItems').flatMap((item) => {
    const g = grounded(item);
    return g ? [{ ...g, owner: statedIn(item.owner, g.quote), due: statedIn(item.due, g.quote) }] : [];
  });
  return { minutes: { decisions: items('decisions'), actionItems, openQuestions: items('openQuestions') }, dropped, cleared };
}

export function buildMinutesPrompt(meeting: MeetingSummaryRecord): string {
  return [
    `会议「${meeting.title}」刚结束，请整理会后纪要。`,
    `1. 先调用 meeting_records，action 用 read，meeting_id 用 ${meeting.id}，读完整场转写。`,
    '2. 只依据转写整理三类内容：决策（会上明确定下来的）、行动项（会上明确要做的事）、未解问题（提出了但没定的）。',
    '3. 每一条都要带 quote：从转写里原样复制的一句原话，不改字、不拼接。找不到原话支撑的不要写。',
    '4. 行动项的 owner / due 只有在那句原话里明说了才填（例如「这个我来跟」「周五前给到」），没说就填 null，不要从上下文推测，也不要采用妙记或腾讯会议 AI 列的负责人。',
    '5. 最后只输出一个代码块，不要别的文字：',
    '```meeting_minutes',
    '{"decisions":[{"text":"…","quote":"…"}],"actionItems":[{"text":"…","quote":"…","owner":null,"due":null}],"openQuestions":[{"text":"…","quote":"…"}]}',
    '```',
    '没有的类别给空数组。',
  ].join('\n');
}

export type MinutesRunner = (input: {
  roleId: string;
  sessionId: string;
  prompt: string;
  allowedToolNames: string[];
  maxIterations?: number;
}) => Promise<{ finalOutput: string }>;

export interface MeetingMinutesDeps {
  store: MeetingRecordStore;
  /** 设置里「散会自动出纪要」，缺省开 */
  isEnabled: () => boolean;
  createSession: (meeting: MeetingSummaryRecord) => Promise<{ id: string }>;
  runner: MinutesRunner;
}

/** 一场会出一次纪要。manual=true 是会议页上用户点「重新出纪要」，不看自动开关 */
export async function runMeetingMinutes(meetingId: string, deps: MeetingMinutesDeps, manual = false): Promise<void> {
  const { store } = deps;
  const meeting = store.get(meetingId);
  if (!meeting) {
    logger.warn('[会议纪要] 找不到会议，不出纪要', { meetingId });
    return;
  }
  if (!manual && !deps.isEnabled()) {
    logger.info('[会议纪要] 自动出纪要已关闭，跳过', { meetingId });
    store.setMinutesState(meetingId, 'skipped');
    return;
  }
  const transcript = store.transcript(meeting).map((l) => l.text).join('\n');
  if (transcript.replace(/\s/g, '').length < MEETING_SESSION_LIMITS.MINUTES_MIN_TRANSCRIPT_CHARS) {
    logger.info('[会议纪要] 转写太短，跳过', { meetingId, chars: transcript.length });
    store.setMinutesState(meetingId, 'skipped');
    return;
  }
  store.setMinutesState(meetingId, 'pending');
  let sessionId: string | null = null;
  try {
    const session = await deps.createSession(meeting);
    sessionId = session.id;
    store.setMinutesState(meetingId, 'running', sessionId);
    const { finalOutput } = await deps.runner({
      roleId: MINUTES_ROLE_ID,
      sessionId,
      prompt: buildMinutesPrompt(meeting),
      allowedToolNames: ['meeting_records'],
      maxIterations: MEETING_SESSION_LIMITS.MINUTES_MAX_ITERATIONS,
    });
    const result = validateMinutes(finalOutput, transcript);
    if (!result) {
      logger.warn('[会议纪要] 记言没有按格式交回纪要', { meetingId, sessionId, outputChars: finalOutput.length });
      store.setMinutesState(meetingId, 'failed', sessionId);
      return;
    }
    store.saveMinutes(meetingId, result.minutes);
    logger.info('[会议纪要] 已出纪要', {
      meetingId,
      decisions: result.minutes.decisions.length,
      actionItems: result.minutes.actionItems.length,
      openQuestions: result.minutes.openQuestions.length,
      droppedUngrounded: result.dropped,
      clearedOwnerOrDue: result.cleared,
    });
  } catch (error) {
    logger.warn('[会议纪要] 出纪要失败', { meetingId, sessionId, error: error instanceof Error ? error.message : String(error) });
    store.setMinutesState(meetingId, 'failed', sessionId);
  }
}

let queueTail: Promise<void> = Promise.resolve();

/** 入队，立刻返回；队列里每节自吞错，永不 reject */
export function enqueueMeetingMinutes(meetingId: string, manual = false, deps?: MeetingMinutesDeps): void {
  queueTail = queueTail.then(async () => {
    try {
      await runMeetingMinutes(meetingId, deps ?? await defaultDeps(), manual);
    } catch (error) {
      logger.warn('[会议纪要] 队列任务异常', { meetingId, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** 测试用：等队列里已入的任务跑完 */
export function drainMeetingMinutesQueue(): Promise<void> {
  return queueTail;
}

async function defaultDeps(): Promise<MeetingMinutesDeps> {
  const { getMeetingRecordStore } = await import('./meetingRecordsDefault');
  const { getConfigService } = await import('../core/configService');
  const { defaultFirstWakeRunner } = await import('../roleAssets/roleFirstWake');
  return {
    store: await getMeetingRecordStore(),
    isEnabled: () => getConfigService().getSettings().meeting?.autoMinutes !== false,
    createSession: createMinutesSession,
    runner: defaultFirstWakeRunner,
  };
}

/** 记言出纪要的会话：会议页「本场产物」从这里进。建法与首次醒来相同（不落到 process.cwd()，那是安装目录） */
async function createMinutesSession(meeting: MeetingSummaryRecord): Promise<{ id: string }> {
  const { getSessionManager } = await import('../infra/sessionManager');
  const { getConfigService } = await import('../core/configService');
  const { resolveSessionDefaultModelConfig } = await import('../core/sessionDefaults');
  const sessionManager = getSessionManager();
  const settings = getConfigService().getSettings();
  const currentSessionId = sessionManager.getCurrentSessionId();
  const currentSession = currentSessionId ? await sessionManager.getSession(currentSessionId) : null;
  return sessionManager.createSession({
    title: `会议纪要：${meeting.title}`,
    modelConfig: resolveSessionDefaultModelConfig({
      provider: settings.model?.provider || currentSession?.modelConfig.provider,
      model: settings.model?.model || currentSession?.modelConfig.model,
      temperature: settings.model?.temperature ?? currentSession?.modelConfig.temperature,
      maxTokens: settings.model?.maxTokens ?? currentSession?.modelConfig.maxTokens,
    }),
    workingDirectory: currentSession?.workingDirectory
      ?? process.env.CODE_AGENT_WORKING_DIR?.trim()
      ?? settings.workspace?.pinnedDirectory
      ?? settings.workspace?.recentDirectories?.[0]
      ?? settings.workspace?.defaultDirectory,
    type: 'schedule',
    origin: {
      kind: 'cron',
      name: ROLE_PROACTIVITY.CADENCE_JOB_TAG,
      metadata: { roleId: MINUTES_ROLE_ID, trigger: 'meeting_minutes', meetingId: meeting.id },
    },
  });
}

