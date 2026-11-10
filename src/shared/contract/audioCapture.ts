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
