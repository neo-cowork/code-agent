interface AudioCaptureErrorText {
  desktopRuntimeUnavailable: string;
  generic: string;
}

/** Keep implementation details out of the settings error banner. */
export function getAudioCaptureErrorText(error: unknown, text: AudioCaptureErrorText): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/tauri runtime not available/i.test(raw)) {
    return text.desktopRuntimeUnavailable;
  }
  return text.generic;
}
