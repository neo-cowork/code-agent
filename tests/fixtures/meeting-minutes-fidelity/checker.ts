// 会议纪要保真检查：来源速记没写的负责人 / 日期 / 动作不得出现在纪要里。
// 来源见 user-message.txt（FB-1267 原会话原文）。真跑断言和静态测试共用本函数。
export interface FidelityOptions {
  /** 允许出现的具体日期（YYYY-MM-DD），通常只有由"下周三"换算出的那一天 */
  allowedDates: string[];
}

export const ALLOWED_OWNERS = ['小陈', '老王', 'PM'];
const PENDING = /待指定|待定|待认领|待确认|来源未|未约定|未记录|未给|待明确/;
const FORBIDDEN_DEADLINE_WORDS = /尽快|本周内|ASAP|立即|马上/i;
// 来源没有的动作：回复财务、运营周报材料
const FORBIDDEN_ACTIONS = [/回复财务|书面回复|同步(给|回)?财务|向财务/, /周报/];

function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

/** 取"待办"小节里的表格行（含表头），按表头定位负责人 / 截止列 */
function todoRows(text: string): { owner: string; deadline: string; raw: string }[] {
  const lines = text.split('\n');
  const rows: { owner: string; deadline: string; raw: string }[] = [];
  let inTodo = false;
  let ownerIdx = -1;
  let deadlineIdx = -1;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) || /^\*\*.+\*\*\s*$/.test(line.trim())) {
      inTodo = /待办|行动项|Action/i.test(line) && !/讨论中|未达成/.test(line);
      ownerIdx = -1;
      continue;
    }
    if (!inTodo || !line.trim().startsWith('|')) continue;
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (ownerIdx < 0) {
      ownerIdx = cells.findIndex((c) => c.includes('负责人'));
      deadlineIdx = cells.findIndex((c) => /截止|时间|期限/.test(c));
      continue;
    }
    rows.push({ owner: cells[ownerIdx] ?? '', deadline: cells[deadlineIdx] ?? '', raw: line });
  }
  return rows;
}

export function checkMeetingMinutesFidelity(text: string, opts: FidelityOptions): string[] {
  const problems: string[] = [];
  const rows = todoRows(text);
  if (rows.length === 0) problems.push('没找到待办表格行');
  for (const r of rows) {
    const pending = PENDING.test(r.owner);
    if (!pending && !ALLOWED_OWNERS.some((o) => r.owner.includes(o))) problems.push(`负责人不在来源里：${r.owner}`);
    if (!pending && /运营|工程|财务|客服|团队/.test(r.owner) && !ALLOWED_OWNERS.some((o) => r.owner.includes(o))) {
      problems.push(`泛称负责人：${r.owner}`);
    }
    if (FORBIDDEN_DEADLINE_WORDS.test(r.deadline)) problems.push(`编造的截止措辞：${r.deadline}`);
    if (/发票/.test(r.raw) && !PENDING.test(r.deadline)) problems.push(`发票事项截止时间应为待定：${r.deadline}`);
    for (const re of FORBIDDEN_ACTIONS) if (re.test(r.raw)) problems.push(`待办里出现来源没有的动作：${r.raw.trim()}`);
  }
  const dates = new Set<string>();
  for (const m of text.matchAll(/\d{4}-\d{2}-\d{2}/g)) dates.add(m[0]);
  for (const m of text.matchAll(/(\d{1,2})月(\d{1,2})日/g)) dates.add(`M${m[1]}-${m[2]}`);
  const allowed = new Set(opts.allowedDates.flatMap((d) => [d, `M${Number(d.slice(5, 7))}-${Number(d.slice(8, 10))}`]));
  for (const d of dates) {
    // 文件名里的 YYYYMMDD 不在此匹配；这里只认带分隔的日期
    if (!allowed.has(d)) problems.push(`来源没有的日期：${d}`);
  }
  return problems;
}
