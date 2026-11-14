/** How long a background-capture wav is kept after its transcription fails. */
export const FAILED_AUDIO_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * 「记这场会」自动结束阈值（N-MEETING-SESSION，爸 11-14 定：10 分钟提醒、20 分钟自动停）。
 * 静音 = 这场会里连续这么久没有转写出人声；睡眠 = 巡检定时器中间断了这么久（合盖/睡眠）。
 */
export const MEETING_SESSION_LIMITS = {
  SILENCE_WARN_MS: 10 * 60 * 1000,
  SILENCE_END_MS: 20 * 60 * 1000,
  MAX_DURATION_MS: 4 * 60 * 60 * 1000,
  SLEEP_GAP_MS: 2 * 60 * 1000,
  TICK_MS: 30 * 1000,
} as const;
