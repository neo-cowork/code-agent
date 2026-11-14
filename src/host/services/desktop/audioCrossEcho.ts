// ============================================================================
// 会议模式两路去重：同一句话被麦克风和系统音频各录了一遍，只留一条
// 移植自 meeting-scribe drop_cross_echo（提交 5441241）。
//
// 去哪条：系统音频里只有会议软件播出来的远端声音（采集排除了本进程），
// 一句话出现在系统音频里就是对方说的；麦克风那条是外放被串录进来的，删麦克风那条。
// ============================================================================

const ECHO_MIN_BLOCK = 3; // 零散单字（「对」「的」）不算相同
const ECHO_MIN_SAME = 6; // 「对对对」这类短句会误配，合计不到 6 个相同字不判
const ECHO_MIN_RATIO = 0.5;
/** 两段时间允许的错位：两路各自做语音切段，起止对不齐 */
export const ECHO_TIME_SLACK_MS = 1000;

function normalize(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 最长公共子串，递归拆左右两半——等价于 difflib.SequenceMatcher 的匹配块 */
function matchedChars(a: string, b: string): number {
  if (a.length < ECHO_MIN_BLOCK || b.length < ECHO_MIN_BLOCK) return 0;
  let best = 0;
  let bestA = 0;
  let bestB = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) {
          best = cur[j];
          bestA = i - best;
          bestB = j - best;
        }
      }
    }
    prev = cur;
  }
  if (best < ECHO_MIN_BLOCK) return 0;
  return best
    + matchedChars(a.slice(0, bestA), b.slice(0, bestB))
    + matchedChars(a.slice(bestA + best), b.slice(bestB + best));
}

/** 两句话字面相同的比例（按短的那句算）；不够判重时返回 0 */
export function crossEchoRatio(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  const same = matchedChars(x, y);
  return same >= ECHO_MIN_SAME ? same / Math.min(x.length, y.length) : 0;
}

export interface EchoCandidate {
  id: string;
  startAtMs: number;
  endAtMs: number;
  transcript: string;
}

export function isCrossEcho(mic: EchoCandidate, others: EchoCandidate): boolean {
  const overlaps = mic.startAtMs < others.endAtMs + ECHO_TIME_SLACK_MS
    && others.startAtMs < mic.endAtMs + ECHO_TIME_SLACK_MS;
  return overlaps && crossEchoRatio(mic.transcript, others.transcript) >= ECHO_MIN_RATIO;
}

/** 麦克风段里哪些是对方声音的串录，返回要删的麦克风段 id */
export function micEchoIds(mic: EchoCandidate[], others: EchoCandidate[]): string[] {
  return mic.filter((m) => others.some((o) => isCrossEcho(m, o))).map((m) => m.id);
}
