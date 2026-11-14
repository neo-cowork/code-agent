// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import type { AudioCapturePrerequisites } from '../../../src/shared/contract/audioCapture';
import type * as NativeDesktop from '../../../src/renderer/services/nativeDesktop';
import type { AudioCaptureStatus } from '../../../src/renderer/services/nativeDesktop';

const services = vi.hoisted(() => ({
  getAudioCaptureStatus: vi.fn(),
  clearAudioRecordings: vi.fn(),
  getNativeDesktopCollectorStatus: vi.fn(async () => ({ running: false })),
  listRecentNativeDesktopEvents: vi.fn(async () => []),
  listAudioSegments: vi.fn<typeof NativeDesktop.listAudioSegments>(async () => []),
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
  startAudioCapture: (mode: 'microphone' | 'system-audio' | 'meeting') => services.startAudioCapture(mode),
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

const jargon = /OpenChronicle|sox|ffmpeg|VAD|ASR|whisper|onnx|brew|npm|\/opt\/|\/usr\//i;
const cases = [
  {
    code: 'recorder_missing',
    key: 'recorderMissing',
    status: { recorder: { microphone: 'missing', systemAudio: 'missing' } },
  },
  {
    code: 'transcription_engine_missing',
    key: 'transcriptionEngineMissing',
    status: { transcriptionEngine: 'missing' },
  },
  {
    code: 'transcription_model_missing',
    key: 'transcriptionModelMissing',
    status: { transcriptionEngine: 'missing', missing: ['transcription_model_missing'] },
  },
  {
    code: 'voice_detection_missing',
    key: 'voiceDetectionMissing',
    status: { voiceDetection: 'missing' },
  },
] as const;

function expectNoAudioError(section: HTMLElement, text: typeof zh.settings.nativeDesktop | typeof en.settings.nativeDesktop) {
  for (const message of Object.values(text.audioErrors)) {
    expect(section.textContent).not.toContain(message);
  }
  expect(section.textContent).not.toMatch(/audioErrors\.|voice_detection_missing|AUDIO_START_FAILED|dlopen failed|Error:/);
}

describe('NativeDesktopSection isolated audio hints on the rendered DOM', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    services.getNativeDesktopCollectorStatus.mockResolvedValue({ running: false });
    services.listRecentNativeDesktopEvents.mockResolvedValue([]);
    services.listAudioSegments.mockResolvedValue([]);
  });

  afterEach(cleanup);

  for (const language of ['zh', 'en'] as const) {
    describe(language, () => {
      beforeEach(() => { i18nState.language = language; });
      const text = (language === 'zh' ? zh : en).settings.nativeDesktop;

      for (const { code, key, status } of cases) {
        it(`${code}: exactly one localized hint + next step, Re-check and empty-day sentence; whole-section DOM has no jargon`, async () => {
          services.getAudioCaptureStatus.mockResolvedValue(makeStatus({ ...status, missing: [code] }));
          const { container } = render(React.createElement(NativeDesktopSection));
          const section = container.firstElementChild as HTMLElement;
          const readiness = await screen.findByTestId('audio-capture-readiness');
          const lines = readiness.querySelectorAll('span[data-prerequisite-code]');
          expect(section.contains(readiness)).toBe(true);
          expect(lines).toHaveLength(1);
          expect(lines[0].getAttribute('data-prerequisite-code')).toBe(code);
          // Exact localized sentence pins the item-to-copy mapping, including its next step.
          expect(lines[0].textContent).toBe(text.audioReadiness[key]);
          expect(readiness.contains(screen.getByRole('button', { name: text.audioReadiness.recheck }))).toBe(true);
          const emptyDay = await screen.findByText(text.emptyDay);
          expect(section.contains(emptyDay)).toBe(true);
          expect(section.textContent).toContain(text.emptyDay);
          expect(section.textContent).not.toMatch(jargon);
          expect(services.startAudioCapture).not.toHaveBeenCalled();
        });
      }

      it('Re-check clears the fixed hint, then Record calls startAudioCapture x1 and shows recording without any audio error', async () => {
        services.getAudioCaptureStatus.mockResolvedValue(makeStatus({
          voiceDetection: 'missing', missing: ['voice_detection_missing'],
        }));
        services.startAudioCapture.mockResolvedValue(makeStatus({}, true));
        const { container } = render(React.createElement(NativeDesktopSection));
        const section = container.firstElementChild as HTMLElement;
        await screen.findByTestId('audio-capture-readiness');
        services.getAudioCaptureStatus.mockResolvedValue(makeStatus());
        fireEvent.click(screen.getByRole('button', { name: text.audioReadiness.recheck }));
        await waitFor(() => expect(screen.queryByTestId('audio-capture-readiness')).toBeNull());
        expect(services.getAudioCaptureStatus).toHaveBeenCalledTimes(2);
        fireEvent.click(screen.getByRole('button', { name: text.recording.record }));
        const recording = await screen.findByRole('button', { name: text.recording.recording });
        await waitFor(() => expect((recording as HTMLButtonElement).disabled).toBe(false));
        expect(services.startAudioCapture).toHaveBeenCalledExactlyOnceWith('meeting');
        expect(recording.textContent).toContain(text.recording.recording);
        expect(screen.queryByTestId('audio-capture-readiness')).toBeNull();
        expectNoAudioError(section, text);
        expect(section.textContent).not.toMatch(jargon);
      });

      it('voice_detection_missing rejection keeps the hint visible and Record enabled; a second click calls startAudioCapture x2', async () => {
        // Keep status ready: the rejection enum itself must preserve the hint.
        services.getAudioCaptureStatus.mockResolvedValue(makeStatus());
        services.startAudioCapture.mockRejectedValue(new Error('voice_detection_missing'));
        const { container } = render(React.createElement(NativeDesktopSection));
        const section = container.firstElementChild as HTMLElement;
        await screen.findByText(text.emptyDay);
        expect(screen.queryByTestId('audio-capture-readiness')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: text.recording.record }));
        const readiness = await screen.findByTestId('audio-capture-readiness');
        expect(readiness.querySelector('[data-prerequisite-code="voice_detection_missing"]')?.textContent)
          .toBe(text.audioReadiness.voiceDetectionMissing);
        const record = screen.getByRole('button', { name: text.recording.record }) as HTMLButtonElement;
        await waitFor(() => expect(record.disabled).toBe(false));
        expect(services.startAudioCapture).toHaveBeenCalledTimes(1);
        expectNoAudioError(section, text);
        fireEvent.click(record);
        await waitFor(() => expect(services.startAudioCapture).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(record.disabled).toBe(false));
        expect(screen.getByTestId('audio-capture-readiness').textContent).toContain(text.audioReadiness.voiceDetectionMissing);
        expect(screen.queryByRole('button', { name: text.recording.recording })).toBeNull();
        expectNoAudioError(section, text);
        expect(section.textContent).not.toMatch(jargon);
      });
    });
  }
});
