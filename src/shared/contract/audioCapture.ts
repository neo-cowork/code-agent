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
