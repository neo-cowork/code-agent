import { CRON_AGENT_SNAPSHOT } from '../../shared/constants';
import { formatTodayAnchor } from '../../shared/todayAnchor';

function resolveTimeZone(timeZone?: string): string {
  if (timeZone) {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone });
      return timeZone;
    } catch {
      // 非法 IANA 名：回落宿主时区（保持旧行为）
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function zonedParts(date: Date, timeZone: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** 该时刻 timeZone 相对 UTC 的偏移（毫秒）。 */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const q = zonedParts(date, timeZone);
  const wall = Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second);
  return wall - Math.floor(date.getTime() / 1000) * 1000;
}

/** timeZone 内 y-m-d 00:00 的 Unix 秒；在候选午夜处重算偏移，跨 DST 安全。 */
function zonedMidnightEpoch(y: number, m: number, d: number, timeZone: string): number {
  const wall = Date.UTC(y, m - 1, d);
  const guess = wall - zoneOffsetMs(new Date(wall), timeZone);
  return Math.floor((wall - zoneOffsetMs(new Date(guess), timeZone)) / 1000);
}

function formatZonedMinute(date: Date, timeZone: string): string {
  const q = zonedParts(date, timeZone);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${q.year}-${two(q.month)}-${two(q.day)} ${two(q.hour)}:${two(q.minute)}`;
}

/**
 * 只有开了变化追踪的任务才包装 prompt；没开的任务原样发送，行为完全不变。
 *
 * 首次运行（还没有旧快照）同样要带上「输出快照标记」这句——否则模型根本不知道
 * 要吐标记，第一次必然拿不到快照，就只能退而求其次拿整段回答顶替，
 * 于是把一坨叙述性文字当成状态注回下一轮。
 */
export function buildCronAgentPrompt(
  prompt: string,
  snapshot: unknown,
  enabled: boolean,
  now: Date = new Date(),
  urgencyCriteria?: string,
  notifyWhen?: string,
  timeZone?: string,
): string {
  // 注入当前时间锚点：LLM 默认拿训练期日期，会把「今天/明天」算成过去时间。
  // 真机 dogfood(2026-07-24)证明「只给 ISO 时间」不够：GLM-5 认出了今天日期，却仍把
  // 本地当天 epoch 算成 2025 年、错时区——模型的 epoch 算术不可信。所以直接把算好的
  // 当天/次日本地 00:00 的 Unix 秒喂给它，让它照抄不换算。
  // 一次运行只认一个时区：job 的 schedule.timezone（croner 也按它触发）；缺省/非法回落宿主时区。
  const zone = resolveTimeZone(timeZone);
  const todayAnchor = formatTodayAnchor(now, zone);
  const todayEpoch = zonedMidnightEpoch(todayAnchor.year, todayAnchor.month, todayAnchor.day, zone);
  const next = new Date(Date.UTC(todayAnchor.year, todayAnchor.month - 1, todayAnchor.day + 1));
  const tomorrowEpoch = zonedMidnightEpoch(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), zone);
  const timeAnchor =
    `【当前时间】${now.toISOString()}（UTC）。时区 ${zone}，当地时间 ${formatZonedMinute(now, zone)}，今天本地日期是 ${todayAnchor.isoDate}。`
    + `若要按「今天/本地当天」查询时间戳，直接用这两个算好的值，不要自己换算年份：`
    + `今天本地 00:00 = ${todayEpoch}（Unix 秒），次日本地 00:00 = ${tomorrowEpoch}（Unix 秒）。`
    + '其他相对时间以【当前时间】为基准，不要用你训练时的日期。';
  const personalChatSourceRule =
    '若任务涉及微信/IM 等个人聊天来源，不要搜索或调用读取个人聊天记录的工具、技能或命令行，直接在产出中单独写一行「未读取：微信/IM（定时任务默认不读个人聊天记录）」。';
  // 用户自定义 must_today 判据（N-CRON-MORNING-TRIAGE-URGENCY-RULE）：给了就替换
  // 括号里 must_today 的内置定义，其余档位定义与 urgency 头格式不动；缺省/空白时
  // 拼回内置定义，产出与旧版逐字节相同。
  const trimmedCriteria = urgencyCriteria?.trim();
  const mustTodayDefinition = trimmedCriteria ? `must_today = ${trimmedCriteria}` : 'must_today = 今天需要用户处理';
  const deliveryDigestInstruction =
    '最后请在回复末尾追加简短的 <cron_summary>...</cron_summary> 块：先写结果摘要；每个生成的文件或可访问产物另起一行，格式为 artifact: <path>。'
    + `摘要的第一行可以标注紧急程度，格式为 urgency: must_today|can_wait|fyi（${mustTodayDefinition}，can_wait = 可以稍后处理，fyi = 仅供参考）。`;
  // notifyWhen 打扰判据（N-CRON-RESTATE-HUMAN-WHEN）：设置后让模型自判本次是否
  // 值得打扰——满足判据才输出 <cron_alert>，host 侧按该标记门通知与推送。
  // 缺省/空白时这条指令整体缺席，产出与旧版逐字节相同。
  const trimmedNotifyWhen = notifyWhen?.trim();
  const notifyGateInstruction = trimmedNotifyWhen
    ? `打扰规则（用户设定）：本次运行只有当结果满足「${trimmedNotifyWhen}」时，才在回复末尾追加一行 <cron_alert>用一句话说明满足了什么</cron_alert>；不满足时不要输出 <cron_alert> 标记（该轮将不打扰用户）。`
    : '';
  if (!enabled) {
    return [prompt, '', timeAnchor, '', personalChatSourceRule, '', deliveryDigestInstruction, ...(notifyGateInstruction ? ['', notifyGateInstruction] : [])].join('\n');
  }

  const hasSnapshot = typeof snapshot === 'string' && Boolean(snapshot.trim());
  return [
    prompt,
    '',
    timeAnchor,
    '',
    personalChatSourceRule,
    ...(hasSnapshot
      ? [
        '',
        '上次运行看到的快照：',
        '<previous_snapshot>',
        snapshot as string,
        '</previous_snapshot>',
        '',
        '请把上面的快照和本次看到的内容对比，这次只需要说明变化。',
      ]
      : []),
    '',
    '回复末尾请用 <cron_snapshot>...</cron_snapshot> 包住本次需要记住的简短快照，供下次对比。',
    '',
    deliveryDigestInstruction,
    ...(notifyGateInstruction ? ['', notifyGateInstruction] : []),
  ].join('\n');
}

export function truncateUtf8Snapshot(snapshot: string): { value: string; truncated: boolean } {
  const bytes = Buffer.from(snapshot, 'utf8');
  if (bytes.length <= CRON_AGENT_SNAPSHOT.MAX_BYTES) {
    return { value: snapshot, truncated: false };
  }

  let end = CRON_AGENT_SNAPSHOT.MAX_BYTES;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return { value: bytes.subarray(0, end).toString('utf8'), truncated: true };
}
