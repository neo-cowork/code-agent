import React from 'react';
import type { AudioCaptureMissingPrerequisiteCode } from '@shared/contract/audioCapture';
import { GhostButton } from '../../../primitives/Button';
import type { AudioCaptureStatus } from '../../../../services/nativeDesktop';

interface AudioReadinessText {
  recorderMissing: string;
  systemAudioHelperMissing: string;
  transcriptionEngineMissing: string;
  voiceDetectionMissing: string;
  voiceDetectionUnsupported: string;
  recheck: string;
}

const KNOWN_CODES: ReadonlySet<AudioCaptureMissingPrerequisiteCode> = new Set([
  'recorder_missing',
  'system_audio_helper_missing',
  'transcription_engine_missing',
  'voice_detection_missing',
  'voice_detection_unsupported',
]);

export function isAudioPrerequisiteCode(value: string): value is AudioCaptureMissingPrerequisiteCode {
  return KNOWN_CODES.has(value as AudioCaptureMissingPrerequisiteCode);
}

export async function loadDayAndHourAudioSegments(
  date: Date,
  hour: number,
  fetchSegments: (from: number, to: number) => Promise<Array<{ start_at_ms: number; end_at_ms: number }>>,
): Promise<{ dayCount: number; hourSegments: unknown[] }> {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);
  const hourStart = new Date(date);
  hourStart.setHours(hour, 0, 0, 0);
  const hourEnd = new Date(date);
  hourEnd.setHours(hour, 59, 59, 999);
  const segs = await fetchSegments(dayStart.getTime(), dayEnd.getTime());
  return {
    dayCount: segs.length,
    hourSegments: segs.filter((s) => s.start_at_ms <= hourEnd.getTime() && s.end_at_ms >= hourStart.getTime()),
  };
}

function computeMissingAudioPrerequisites(
  status: AudioCaptureStatus | null,
  selectedMode: 'microphone' | 'system-audio',
  failedCode?: AudioCaptureMissingPrerequisiteCode | null,
): AudioCaptureMissingPrerequisiteCode[] {
  const codes: AudioCaptureMissingPrerequisiteCode[] = [];
  const add = (code: AudioCaptureMissingPrerequisiteCode) => {
    if (!codes.includes(code)) codes.push(code);
  };

  if (failedCode) add(failedCode);
  if (!status || status.capturing) return codes;

  const prereqs = status.prerequisites;
  if (prereqs) {
    const micReady = prereqs.recorder.microphone === 'ready';
    const sysReady = prereqs.recorder.systemAudio === 'ready';
    if (selectedMode === 'system-audio') {
      if (!sysReady && !micReady) add('recorder_missing');
      else if (!sysReady) add('system_audio_helper_missing');
    } else if (!micReady) {
      add('recorder_missing');
    }
    if (prereqs.transcriptionEngine === 'missing') {
      add('transcription_engine_missing');
    }
    if (prereqs.voiceDetection === 'unsupported') {
      add('voice_detection_unsupported');
    } else if (prereqs.voiceDetection !== 'ready') {
      add('voice_detection_missing');
    }
  } else if (status.missingPrerequisites) {
    for (const item of status.missingPrerequisites) {
      if (selectedMode === 'microphone' && item === 'system_audio_helper_missing') continue;
      add(item);
    }
  }

  return codes;
}

function messageForCode(code: AudioCaptureMissingPrerequisiteCode, text: AudioReadinessText): string {
  switch (code) {
    case 'recorder_missing':
      return text.recorderMissing;
    case 'system_audio_helper_missing':
      return text.systemAudioHelperMissing;
    case 'transcription_engine_missing':
      return text.transcriptionEngineMissing;
    case 'voice_detection_missing':
      return text.voiceDetectionMissing;
    case 'voice_detection_unsupported':
      return text.voiceDetectionUnsupported;
  }
}

export const NativeDesktopEmptyView: React.FC<{
  emptyDay: boolean;
  icon: React.ReactNode;
  text: { emptyDay: string; emptyHour: string };
}> = ({ emptyDay, icon, text }) => {
  return (
    <div className="flex items-center justify-center h-full text-zinc-600">
      <div className="text-center">
        {icon}
        <div className="text-sm">{emptyDay ? text.emptyDay : text.emptyHour}</div>
      </div>
    </div>
  );
};

export const AudioCaptureReadinessLine: React.FC<{
  status: AudioCaptureStatus | null;
  mode: 'microphone' | 'system-audio';
  failedCode?: AudioCaptureMissingPrerequisiteCode | null;
  text: AudioReadinessText;
  onRecheck: () => void;
}> = ({ status, mode, failedCode, text, onRecheck }) => {
  const missing = computeMissingAudioPrerequisites(status, mode, failedCode);
  if (missing.length === 0) return null;

  return (
    <div
      data-testid="audio-capture-readiness"
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-zinc-800/50 px-5 py-1.5 text-[11px] text-badge-warning shrink-0"
    >
      <div className="flex flex-col gap-0.5">
        {missing.map((code) => (
          <span key={code} data-prerequisite-code={code}>
            {messageForCode(code, text)}
          </span>
        ))}
      </div>
      <GhostButton type="button" size="sm" onClick={onRecheck}>
        {text.recheck}
      </GhostButton>
    </div>
  );
};
