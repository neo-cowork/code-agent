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
export type MeetingState = 'recording' | 'paused' | 'ended';
export type MeetingEndReason = 'manual' | 'silence' | 'max_duration' | 'sleep' | 'capture_stopped' | 'interrupted';

export interface MeetingRecord {
  id: string;
  title: string;
  startedAtMs: number;
  endedAtMs: number | null;
  state: MeetingState;
  endReason: MeetingEndReason | null;
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
