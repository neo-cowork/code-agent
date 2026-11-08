// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import type { AudioCapturePrerequisites } from '../../../src/shared/contract/audioCapture';
import type { AudioCaptureStatus } from '../../../src/renderer/services/nativeDesktop';

const services = vi.hoisted(() => ({
  getAudioCaptureStatus: vi.fn(),
  clearAudioRecordings: vi.fn(),
  getNativeDesktopCollectorStatus: vi.fn(async () => ({ running: false })),
  listRecentNativeDesktopEvents: vi.fn(async () => []),
  listAudioSegments: vi.fn(async () => []),
  startNativeDesktopCollector: vi.fn(),
  stopNativeDesktopCollector: vi.fn(),
  startAudioCapture: vi.fn(),
  stopAudioCapture: vi.fn(),
}));

const facade = vi.hoisted(() => ({
  openNativePath: vi.fn(async () => undefined),
}));

const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => (i18nState.language === 'en'
    ? { t: en, language: 'en' }
    : { t: zh, language: 'zh' }),
}));

vi.mock('../../../src/renderer/services/nativeDesktop', () => ({
  getAudioCaptureStatus: () => services.getAudioCaptureStatus(),
  clearAudioRecordings: () => services.clearAudioRecordings(),
  getNativeDesktopCollectorStatus: () => services.getNativeDesktopCollectorStatus(),
  listRecentNativeDesktopEvents: () => services.listRecentNativeDesktopEvents(),
  listAudioSegments: (from: number, to: number) => services.listAudioSegments(from, to),
  startNativeDesktopCollector: () => services.startNativeDesktopCollector(),
  stopNativeDesktopCollector: () => services.stopNativeDesktopCollector(),
  startAudioCapture: (mode: 'microphone' | 'system-audio') => services.startAudioCapture(mode),
  stopAudioCapture: () => services.stopAudioCapture(),
}));

vi.mock('../../../src/renderer/services/tauriPluginFacade', () => ({
  openNativePath: facade.openNativePath,
}));

import { NativeDesktopSection } from '../../../src/renderer/components/features/settings/sections/NativeDesktopSection';

function makeStatus(overrides: Partial<AudioCapturePrerequisites> = {}, capturing = false): AudioCaptureStatus {
  const prerequisites: AudioCapturePrerequisites = {
    recorder: { microphone: 'ready', systemAudio: 'ready' },
    transcriptionEngine: 'ready',
    voiceDetection: 'ready',
    missing: [],
    ...overrides,
  };
  return {
    capturing,
    captureMode: 'microphone',
    vadReady: capturing,
    soxAvailable: prerequisites.recorder.microphone === 'ready',
    systemAudioAvailable: prerequisites.recorder.systemAudio === 'ready',
    asrEngine: prerequisites.transcriptionEngine === 'ready' ? 'whisper-cpp' : 'none',
    powerMode: 'full',
    totalSegments: 0,
    audioDir: '/tmp/audio',
    queueLength: 0,
    prerequisites,
    missingPrerequisites: prerequisites.missing,
  };
}

describe('NativeDesktopSection audio readiness & empty state', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    i18nState.language = 'zh';
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('maintains zh/en key parity for audioReadiness and emptyDay without jargon', () => {
    expect(Object.keys(zh.settings.nativeDesktop.audioReadiness).sort())
      .toEqual(Object.keys(en.settings.nativeDesktop.audioReadiness).sort());
    expect(zh.settings.nativeDesktop.emptyDay).toBeTruthy();
    expect(en.settings.nativeDesktop.emptyDay).toBeTruthy();

    const allStrings = [
      ...Object.values(zh.settings.nativeDesktop.audioReadiness),
      ...Object.values(en.settings.nativeDesktop.audioReadiness),
      zh.settings.nativeDesktop.emptyDay,
      en.settings.nativeDesktop.emptyDay,
    ].join(' ');
    expect(allStrings).not.toMatch(/OpenChronicle|sox|ffmpeg|VAD|ASR|brew install/i);
  });

  it('shows missing prerequisites before clicking Record and clears them on Re-check', async () => {
    services.getAudioCaptureStatus
      .mockResolvedValueOnce(makeStatus({
        recorder: { microphone: 'missing', systemAudio: 'missing' },
        transcriptionEngine: 'missing',
        voiceDetection: 'downloadable',
        missing: ['recorder_missing', 'transcription_engine_missing', 'voice_detection_missing'],
      }))
      .mockResolvedValueOnce(makeStatus());

    render(React.createElement(NativeDesktopSection));

    const readiness = await screen.findByTestId('audio-capture-readiness');
    expect(readiness.textContent).toContain(zh.settings.nativeDesktop.audioReadiness.recorderMissing);
    expect(readiness.textContent).toContain(zh.settings.nativeDesktop.audioReadiness.transcriptionEngineMissing);
    expect(readiness.textContent).toContain(zh.settings.nativeDesktop.audioReadiness.voiceDetectionMissing);

    fireEvent.click(screen.getByRole('button', { name: zh.settings.nativeDesktop.audioReadiness.recheck }));
    await waitFor(() => {
      expect(screen.queryByTestId('audio-capture-readiness')).toBeNull();
    });
  });

  it('reuses the readiness line when startAudioCapture fails with an enum code instead of showing a raw error banner', async () => {
    services.getAudioCaptureStatus
      .mockResolvedValueOnce(makeStatus())
      .mockResolvedValueOnce(makeStatus({
        recorder: { microphone: 'missing', systemAudio: 'missing' },
        missing: ['recorder_missing'],
      }));
    services.startAudioCapture.mockRejectedValueOnce(new Error('recorder_missing'));

    render(React.createElement(NativeDesktopSection));

    await screen.findByText(zh.settings.nativeDesktop.emptyDay);
    expect(screen.queryByTestId('audio-capture-readiness')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: zh.settings.nativeDesktop.recording.record }));
    const readiness = await screen.findByTestId('audio-capture-readiness');
    expect(readiness.textContent).toContain(zh.settings.nativeDesktop.audioReadiness.recorderMissing);
  });

  it('renders empty-day message in zh and en when the selected day has no events or recordings and capture is off', async () => {
    services.getAudioCaptureStatus.mockResolvedValue(makeStatus());
    render(React.createElement(NativeDesktopSection));
    expect(await screen.findByText(zh.settings.nativeDesktop.emptyDay)).toBeTruthy();

    cleanup();
    i18nState.language = 'en';
    services.getAudioCaptureStatus.mockResolvedValue(makeStatus({
      voiceDetection: 'unsupported',
      missing: ['voice_detection_unsupported'],
    }));
    render(React.createElement(NativeDesktopSection));
    expect(await screen.findByText(en.settings.nativeDesktop.emptyDay)).toBeTruthy();
    expect(await screen.findByText(en.settings.nativeDesktop.audioReadiness.voiceDetectionUnsupported)).toBeTruthy();
  });
});
