// ============================================================================
// Browser Keep-Result-Page Claim Gate
// ============================================================================
// A text reply must not tell the user the browser window/page is kept open
// unless the kept-browser registry actually holds a live entry for the session.
// Same retry-once-then-warn shape as desktopActionClaimGate.
import { getHostUiLocale } from '../../config/hostUiLocale';
import { BROWSER_KEEP_CLAIM_GATE_WARNING } from '../../../shared/i18n/browserKeepClaimGateWarning';

const BROWSER_CONTEXT_RE = /浏览器|网页|页面|窗口|结果页|\bbrowser\b|\bwindow\b|\bpage\b|\btab\b/i;

const KEEP_CLAIM_PARTS = [
  '(?:窗口|页面|结果页|浏览器|标签页)[^。！？\\n]{0,12}(?:留着|开着|没(?:有)?关|未(?:被)?关|不会(?:被)?关|没被关|保留(?:着|在)|保持(?:打开|开着|不关|原样)|(?:已|会|仍|将|为你|给你)保留)',
  '(?:窗口|浏览器)[^。！？\\n]{0,12}(?:仍(?:然)?(?:在|开)|还(?:在|开|是开))',
  '(?:保留|留着|留下|保持)(?:了|着)?(?:这个|该|当前|此)?(?:窗口|页面|结果页|浏览器)',
  // 「已停在这个页面」/「停在这个结果页，你可以直接看」= 停给用户；「仍停留在原页面」(没跳转) 不是声明。
  '已停在(?:这个|该|当前|此)(?:结果)?页',
  '停在(?:这个|该|当前|此)?(?:结果)?页面?[^。！？\\n]{0,12}(?:给你|直接看|可以看|供你)',
  '(?:window|page|tab|browser)[^.!?\\n]{0,30}(?:\\b(?:is|was|stays?|remains?|kept|left)\\b[^.!?\\n]{0,10}(?:open|kept)|not (?:been )?closed|still open)',
  '\\bleft\\b[^.!?\\n]{0,20}\\bopen\\b',
];
const KEEP_CLAIM_SRC = KEEP_CLAIM_PARTS.join('|');
const KEEP_CLAIM_RE = new RegExp(KEEP_CLAIM_SRC, 'i');

// Only explicit denials of *keeping* cancel a claim. Negations that are part of the claim itself
// (未关闭 / 没关掉 / 不会关掉 / not closed) are deliberately absent from this list.
const DENIAL_RE =
  /没留着|没有留着|没保留|没有保留|未保留|没能|未能|无法|不能|关了|关掉了|已关|已经关|已被关|被关闭了|不再|没有[^，。]{0,8}(?:开着|还开|仍开|保留|留着)|并没有|could not keep|couldn't keep|unable to keep|not kept|(?<!not )(?:was|is|been|now|already) closed|no longer/i;

function claimsWindowKept(content: string): boolean {
  return content.split(/[。！？!?;；\n]|\.(?=\s|$)/).some(
    (sentence) => KEEP_CLAIM_RE.test(sentence) && !DENIAL_RE.test(sentence),
  );
}

const BROWSER_KEEP_CLAIM_REPAIR_PROMPT = [
  '<browser-keep-claim-guard>',
  'Your previous text response told the user the browser window/page is kept or still open, but keep_result_page has not succeeded in this conversation, so the window is not kept.',
  'If the user asked to keep the result page and the page is still open, call browser_action keep_result_page now.',
  'Otherwise tell the user plainly that the window is closed (and that you can reopen the page). Do not claim it is open.',
  '</browser-keep-claim-guard>',
].join('\n');

export interface BrowserKeepClaimGateInput {
  sessionId: string;
  recentUserMessages?: string[];
  assistantContent: string;
  /** A Browser/browser_action tool call happened in this run. */
  usedBrowserTool: boolean;
  /** How many times this gate already asked the model to repair in this run. */
  retriesDone: number;
}

export type BrowserKeepClaimGateResult =
  | { action: 'none'; content: string; reason?: undefined; repairPrompt?: undefined }
  | { action: 'retry'; content: string; reason: string; repairPrompt: string }
  | { action: 'warn'; content: string; reason: string; repairPrompt?: undefined };

// The registry pulls in the browser stack (pool/service singletons); load it lazily, only once a claim matched.
export async function applyBrowserKeepClaimGate(input: BrowserKeepClaimGateInput): Promise<BrowserKeepClaimGateResult> {
  const content = input.assistantContent || '';
  if (!content.trim() || !claimsWindowKept(content)) return { action: 'none', content };

  const browserContext = input.usedBrowserTool
    || (input.recentUserMessages ?? []).some((text) => BROWSER_CONTEXT_RE.test(text));
  if (!browserContext) return { action: 'none', content };

  const { getKeptBrowserRegistry } = await import('../../services/surfaceExecution/keptBrowserRegistry');
  if (getKeptBrowserRegistry().snapshot(input.sessionId).state === 'kept') return { action: 'none', content };

  const trigger = input.usedBrowserTool ? 'browser_tool_used' : 'user_text_mentions_browser';
  if (input.retriesDone < 1) {
    return {
      action: 'retry',
      content,
      reason: `browser_keep_claim_without_kept_entry:retry:${trigger}`,
      repairPrompt: BROWSER_KEEP_CLAIM_REPAIR_PROMPT,
    };
  }
  return {
    action: 'warn',
    content: `${BROWSER_KEEP_CLAIM_GATE_WARNING[getHostUiLocale()]}\n\n${content}`,
    reason: `browser_keep_claim_without_kept_entry:warn:${trigger}`,
  };
}
