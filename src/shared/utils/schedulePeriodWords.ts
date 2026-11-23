// 从自然语言里读出「时段词 / 星期词」（每晚、每周五、工作日、nightly…），供添加自动化表单与
// 模板频率输入共用同一份词表。纯函数，不碰 LLM。词表刻意很小：不含中午/下午默认钟点。

export interface SchedulePeriodWords {
  freq?: 'weekdays' | 'weekly';
  /** cron day-of-week 0-6，0=周日（freq 为 weekly 时） */
  weekday?: string;
  /** HH:MM */
  time?: string;
  /** 命中并决定了 time 的原词（时段词或钟点原文），用于提示行 */
  matchedWord: string;
}

const EVENING_TIME = '22:00';
const MORNING_TIME = '09:00';

const PERIOD_PATTERNS: Array<{ re: RegExp; time: string }> = [
  { re: /每天晚上|每晚|每夜|晚上|夜里|nightly|every night|every evening/i, time: EVENING_TIME },
  { re: /每天早上|每早|早晨|every morning/i, time: MORNING_TIME },
];

const ZH_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const ZH_WEEKDAY: Record<string, string> = { 日: '0', 天: '0', 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6' };
const EN_WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function zhHour(raw: string): number | null {
  if (/^\d{1,2}$/.test(raw)) return Number(raw);
  if (raw === '十') return 10;
  if (raw.startsWith('十')) return 10 + (ZH_DIGITS[raw[1]] ?? NaN);
  if (raw.length === 2 && raw[1] === '十') return (ZH_DIGITS[raw[0]] ?? NaN) * 10;
  if (raw.length === 1 && raw in ZH_DIGITS) return ZH_DIGITS[raw];
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

function readWeekday(text: string): Pick<SchedulePeriodWords, 'freq' | 'weekday'> {
  if (/周一\s*(?:到|至|-|~)\s*周?五|工作日|weekdays?\b/i.test(text)) return { freq: 'weekdays' };
  if (/周[一二三四五六日天]\s*(?:到|至|-|~)\s*周?[一二三四五六日天]/.test(text)) return {};
  const zh = text.match(/(?:周|星期|礼拜)([一二三四五六日天])/);
  if (zh) return { freq: 'weekly', weekday: ZH_WEEKDAY[zh[1]] };
  const en = text.toLowerCase().match(/\bevery\s+(sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)day\b/);
  if (en) return { freq: 'weekly', weekday: String(EN_WEEKDAYS.indexOf(en[1].slice(0, 3))) };
  return {};
}

/** 显式钟点：HH:MM、8pm 总是生效；「8点」只在同时出现时段词/每天时生效，避免误读目标里的无关数字。 */
function readClock(text: string, allowBare: boolean): { hour: number; minute: number; text: string; index: number; meridiem?: 'am' | 'pm' } | null {
  const colon = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (colon) return { hour: Number(colon[1]), minute: Number(colon[2]), text: colon[0], index: colon.index ?? 0 };
  const ampm = text.match(/(\d{1,2})\s*([ap])\.?m\b\.?/i);
  if (ampm) return { hour: Number(ampm[1]), minute: 0, text: ampm[0], index: ampm.index ?? 0, meridiem: ampm[2].toLowerCase() === 'p' ? 'pm' : 'am' };
  if (!allowBare) return null;
  const zh = text.match(/([零〇一二两三四五六七八九十]{1,3}|\d{1,2})\s*点\s*(半|(\d{1,2})\s*分?)?/);
  if (!zh) return null;
  const hour = zhHour(zh[1]);
  if (hour === null) return null;
  const minute = zh[2] === '半' ? 30 : zh[3] ? Number(zh[3]) : 0;
  return { hour, minute, text: zh[0].trim(), index: zh.index ?? 0 };
}

export function parseSchedulePeriodWords(text: string): SchedulePeriodWords | null {
  if (!text.trim()) return null;
  let period: { word: string; time: string; index: number } | null = null;
  for (const { re, time } of PERIOD_PATTERNS) {
    const m = re.exec(text);
    if (m && (!period || m.index < period.index)) period = { word: m[0], time, index: m.index };
  }
  const week = readWeekday(text);
  const allowBare = period !== null || /每天|every day|daily|下午|傍晚|午后|中午/i.test(text);
  const clock = readClock(text, allowBare);

  let time: string | undefined;
  let word = period?.word ?? '';
  if (clock && clock.hour < 24 && clock.minute < 60) {
    let { hour } = clock;
    // 上下午只认紧挨钟点前面的那个词，文本别处的「下午/早上」不参与换算。
    const lead = text.slice(0, clock.index);
    const evening = /(?:每天晚上|每晚|每夜|晚上|夜里|nightly|every night|every evening)\s*$/i.test(lead);
    const afternoon = /(?:下午|傍晚|午后)\s*$/.test(lead);
    const noon = /中午\s*$/.test(lead);
    if (clock.meridiem === 'pm' && hour < 12) hour += 12;
    else if (clock.meridiem === 'am' && hour === 12) hour = 0;
    else if (!clock.meridiem && evening && hour === 12) hour = 0;
    else if (!clock.meridiem && (evening || afternoon) && hour < 12) hour += 12;
    else if (!clock.meridiem && noon && hour < 6) hour += 12;
    time = `${pad(hour)}:${pad(clock.minute)}`;
    word = clock.text;
  } else if (period) {
    time = period.time;
  }

  if (!time && !week.freq) return null;
  return { ...week, ...(time ? { time } : {}), matchedWord: word };
}

const DAILY_FREQUENCY = /每天|每日|每早(?:上)?|每晚(?:上)?|每夜|\b(?:every\s+(?:day|morning|night|evening)|daily|nightly)\b/gi;
const NON_DAILY_FREQUENCY = /每周|每星期|每礼拜|周末|双休日|\b(?:weekly|every\s+week|weekends?)\b/i;
const DAY_PERIOD = /^\s*(早上|早晨|上午|下午|傍晚|午后|中午|晚上|夜里)/;
const CLOCK_AT = /^\s*(?:at\b|在|于)\s*/i;
const ADJACENT_CLOCK = /^\s*([零〇一二两三四五六七八九十]{1,3}|\d{1,2})(?:\s*[:：]\s*(\d{2})|\s*(点)(?:钟)?(?:\s*(半|\d{1,2}|[二三四五]?十[一二三四五六七八九]?|[零〇][一二三四五六七八九])(?:\s*分)?)?)?(?:\s*([ap])\.?m\b\.?)?(?!\s*[零〇一二两三四五六七八九十\d:：点])/i;
const CLOCK_REVISION = /(?:改成|改到|调到|换成|提前到|推迟到|延后到|\b(?:change|switch|move|reschedule)(?:\s+it)?\s+to)\s*/i;
const SCHEDULE_CANCEL = /(?:取消|停止|关闭|不要|不用|无需|别再?)\s*(?:定时|按时|唤醒|醒来)|\b(?:cancel|stop|disable)\s+(?:the\s+)?(?:schedule|wake[- ]?up)\b/i;
const NEGATED_DAILY = /(?:不要|不用|无需|别再?|取消|停止|不再|\b(?:do not|don't|no longer|cancel|stop)\b)[^，。！？；,.!?;\n]{0,12}$/i;
const BARE_CLOCK_SUFFIX = /^(?:[\p{L}\p{N}]|\s+(?:封|件|条|项|个|次|份|人|页|张|篇))/u;


/**
 * Read a clock attached to an explicit daily phrase before enabling a wake.
 * undefined means no scheduling phrase; null means a newer scheduling phrase
 * is unsupported or has no explicit clock. The cron form keeps its own defaults.
 */
export function readExplicitDailySchedule(text: string): string | null | undefined {
  if (readWeekday(text).freq || NON_DAILY_FREQUENCY.test(text) || SCHEDULE_CANCEL.test(text)) return null;
  let result: string | null | undefined;
  for (const marker of text.matchAll(DAILY_FREQUENCY)) {
    const index = marker.index ?? 0;
    if (NEGATED_DAILY.test(text.slice(0, index))) return null;
    // A marker in the expert name or task text may precede the actual schedule.
    result ??= clockAfterDailyPhrase(marker[0], text.slice(index + marker[0].length));
  }
  if (result !== undefined) return result;

  // A clock-only revision supersedes the earlier request without establishing
  // that Neo should run it every day.
  const revision = CLOCK_REVISION.exec(text);
  if (revision && clockAfterDailyPhrase('', text.slice(revision.index + revision[0].length))) return null;
  return undefined;
}

function clockAfterDailyPhrase(marker: string, tail: string): string | null {
  const period = DAY_PERIOD.exec(tail);
  const afterPeriod = period ? tail.slice(period[0].length) : tail;
  const at = CLOCK_AT.exec(afterPeriod);
  const clockText = at ? afterPeriod.slice(at[0].length) : afterPeriod;
  const clock = ADJACENT_CLOCK.exec(clockText);
  if (!clock) return null;

  const [, hourText, colonMinutes, chime, chineseMinutes, meridiem] = clock;
  const dayPart = period?.[1] ?? marker;
  const evening = /晚|夜|evening|night/i.test(dayPart);
  const afternoon = /下午|傍晚|午后/.test(dayPart);
  const morning = /早|上午|morning/i.test(dayPart);
  const noon = dayPart === '中午';
  if (!colonMinutes && !chime && !meridiem) {
    // An unmarked number needs a time cue and must stand apart from task text.
    if (!(at || evening || afternoon || morning || noon) || BARE_CLOCK_SUFFIX.test(clockText.slice(clock[0].length))) return null;
  }

  let hour = zhHour(hourText);
  const minute = clockMinute(colonMinutes ?? chineseMinutes ?? '0');
  if (hour === null || hour >= 24 || minute === null || minute >= 60 || (meridiem && (hour === 0 || hour > 12))) return null;

  const amPm = meridiem?.toLowerCase();
  if (amPm === 'p' && hour < 12) hour += 12;
  else if (amPm === 'a' && hour === 12) hour = 0;
  else if (!amPm && evening && hour === 12) hour = 0;
  else if (!amPm && (evening || afternoon) && hour < 12) hour += 12;
  else if (!amPm && noon && hour < 6) hour += 12;
  return `${pad(hour)}:${pad(minute)}`;
}

function clockMinute(value: string): number | null {
  if (value === '半') return 30;
  if (/^[零〇]/.test(value)) return ZH_DIGITS[value[1]] ?? null;
  const [tens, ones] = value.split('十');
  if (ones !== undefined) return (tens ? ZH_DIGITS[tens] : 1) * 10 + (ones ? ZH_DIGITS[ones] : 0);
  return zhHour(value);
}
