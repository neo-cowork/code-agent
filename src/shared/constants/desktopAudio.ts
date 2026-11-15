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
  /** 对话按场取转写：正在进行或结束 2 小时内的会单独注入，预算 8000 字（会长了保留最近的） */
  CONTEXT_RECENT_MS: 2 * 60 * 60 * 1000,
  CONTEXT_MAX_CHARS: 8_000,
  /** meeting_records 读一场会时转写的字数上限（出纪要要读全，4 小时的会约这个量级） */
  RECORDS_READ_MAX_CHARS: 60_000,
  /** meeting_records 搜索每次最多返回几条命中 */
  RECORDS_SEARCH_LIMIT: 20,
  /** 从腾讯会议分页拉转写最多拉几页（每页 100 段），防止异常分页无限循环 */
  IMPORT_MAX_PAGES: 60,
  /** 散会自动出纪要：整场转写不到这么多字就不调模型（只有几句寒暄出不了纪要，还白花钱） */
  MINUTES_MIN_TRANSCRIPT_CHARS: 200,
  /** 记言出纪要一次最多走几轮（读一次会议记录 + 写纪要，留点余量） */
  MINUTES_MAX_ITERATIONS: 6,
  /** 纪要里每类最多收几条，防止模型把整场逐句抄进来 */
  MINUTES_MAX_ITEMS_PER_KIND: 30,
  /** 会前提醒：每分钟看一次日历，会开始前 2 分钟内提醒（开始后 2 分钟内录制条仍挂着） */
  CALENDAR_POLL_MS: 60 * 1000,
  CALENDAR_LEAD_MS: 2 * 60 * 1000,
} as const;
