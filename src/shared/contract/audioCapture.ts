/** 采集模式：会议 = 麦克风与系统音频两路同录（N-MEETING-DUALTRACK） */
export type AudioCaptureMode = 'microphone' | 'system-audio' | 'meeting';

/**
 * audio_segments.speaker_id 的取值。单路模式分不出谁在说话，记 UNKNOWN；
 * 会议模式按声道分：麦克风 = 我，系统音频（会议软件里的远端声音）= 对方。
 */
export const AUDIO_SPEAKER_ID = { UNKNOWN: 0, ME: 1, OTHERS: 2 } as const;

type AudioCapturePrerequisiteState = 'ready' | 'missing';
export type AudioCaptureVoiceDetectionState = 'ready' | 'downloadable' | 'missing' | 'unsupported';

export type AudioCaptureMissingPrerequisiteCode =
  | 'recorder_missing'
  | 'system_audio_helper_missing'
  | 'transcription_engine_missing'
  /** 装了 whisper 程序但没下语音模型（~/.cache/whisper 下没有 ggml-*.bin） */
  | 'transcription_model_missing'
  | 'voice_detection_missing'
  | 'voice_detection_unsupported';

export interface AudioCapturePrerequisites {
  recorder: {
    microphone: AudioCapturePrerequisiteState;
    systemAudio: AudioCapturePrerequisiteState;
  };
  transcriptionEngine: AudioCapturePrerequisiteState;
  voiceDetection: AudioCaptureVoiceDetectionState;
  missing: AudioCaptureMissingPrerequisiteCode[];
}

/** 一场会的状态（N-MEETING-SESSION）。出纪要中/完成属于会议页（N-MEETING-PAGE），见 docs/architecture/meeting-session.md */
type MeetingState = 'recording' | 'paused' | 'ended';
export type MeetingEndReason = 'manual' | 'silence' | 'max_duration' | 'sleep' | 'capture_stopped' | 'interrupted';

export interface MeetingRecord {
  id: string;
  title: string;
  startedAtMs: number;
  endedAtMs: number | null;
  state: MeetingState;
  endReason: MeetingEndReason | null;
}

/** 会议从哪来：本机「记这场会」录的，或导入的飞书妙记 / 腾讯会议转写（N-MEETING-PAGE） */
export type MeetingSource = 'recorded' | 'feishu' | 'tmeet';
/** 会后纪要进度：等待中 → 出纪要中 → 完成 / 失败 / 跳过（转写太短或开关关着） */
export type MeetingMinutesState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** 一条纪要内容，quote 是转写里的原话出处 */
export interface MeetingMinutesItem {
  text: string;
  quote: string;
}

/** 行动项：原话没说负责人 / 截止时间的为 null，界面显示「待认领 / 待定」，只列不派 */
export interface MeetingActionItem extends MeetingMinutesItem {
  owner: string | null;
  due: string | null;
}

export interface MeetingMinutes {
  decisions: MeetingMinutesItem[];
  actionItems: MeetingActionItem[];
  openQuestions: MeetingMinutesItem[];
}

/** 一句转写。atMs 是绝对时刻（导入的转写没有时刻时为 null），speaker 为空表示不知道是谁 */
export interface MeetingTranscriptLine {
  atMs: number | null;
  speaker: string;
  text: string;
}

/** 会议页和 meeting_records 工具读到的一场会 */
export interface MeetingSummaryRecord extends MeetingRecord {
  source: MeetingSource;
  /** 导入来源的外部编号：妙记 token / 腾讯会议录制文件 id */
  externalRef: string | null;
  minutesState: MeetingMinutesState | null;
  minutes: MeetingMinutes | null;
  /** 记言出纪要的那条会话（本场产物从这里看） */
  minutesSessionId: string | null;
}

export interface MeetingSessionStatus {
  /** 正在进行（记录中或暂停）的会；没有则 null */
  current: MeetingRecord | null;
  /** 连续多久没转写出人声（暂停时不计） */
  silenceMs: number;
  /** 静音已到提醒线：界面提示「还在开会吗」 */
  silenceWarning: boolean;
  /** 最近一场已结束的会：界面据此提示「已因 X 自动结束」 */
  lastEnded: MeetingRecord | null;
}
