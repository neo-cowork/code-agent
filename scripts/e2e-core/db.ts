import type { AttemptEnv, DbSnapshot } from './types';
import { sleep } from './ui';

type Row = Record<string, unknown>;

export const inSessions = (rows: Row[], ids: string[]): Row[] => rows.filter((r) => ids.includes(String(r.session_id)));

export const describeRows = (rows: Row[], cols: string[]): string =>
  rows.map((r) => cols.map((c) => String(r[c] ?? '')).join(' | ')).join('\n') || '（没有行）';

/** db 落盘有延迟：反复存快照直到 check 返回 null（通过）或超时，超时抛出最后一次的失败说明。 */
export async function expectDb(
  env: AttemptEnv,
  check: (data: DbSnapshot) => string | null,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data, file } = await env.readDb();
    const problem = check(data);
    if (problem === null) return;
    if (Date.now() > deadline) throw new Error(`${problem}（见 ${file}）`);
    await sleep(2_000);
  }
}

/** 会话里最后一条有正文的助手消息（回复文字）。 */
export function lastAssistantText(data: DbSnapshot, ids: string[]): string {
  const rows = inSessions(data.messages, ids).filter((m) => m.role === 'assistant' && String(m.content ?? '').trim());
  return String(rows[rows.length - 1]?.content ?? '').trim();
}

/** 本次尝试的会话 + 它派出的后台/子会话（后台任务里的工具事件落在子会话上）。 */
export function family(data: DbSnapshot, ids: string[]): string[] {
  const all = new Set(ids);
  for (let grew = true; grew;) {
    grew = false;
    for (const s of data.sessions) {
      const parent = String(s.parent_session_id ?? '');
      if (parent && all.has(parent) && !all.has(String(s.id))) { all.add(String(s.id)); grew = true; }
    }
  }
  return [...all];
}
