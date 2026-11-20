// ============================================================================
// Browser Keep-Result-Page Claim Gate
// ============================================================================
// A text reply must not tell the user the browser window/page is kept open
// unless the kept-browser registry actually holds a live entry for the session.
// Same retry-once-then-warn shape as desktopActionClaimGate.
import { getHostUiLocale } from '../../config/hostUiLocale';
import { BROWSER_KEEP_CLAIM_GATE_WARNING } from '../../../shared/i18n/browserKeepClaimGateWarning';

const BROWSER_CONTEXT_RE = /浏览器|网页|页面|窗口|结果页|\bbrowser\b|\bwindow\b|\bpage\b|\btab\b/i;

const KEEP_CLAIM_RE = new RegExp(
  [
    '(?:窗口|页面|结果页|浏览器|标签页)[^。！？\\n]{0,12}(?:保留|留着|留在|开着|没(?:有)?关|不会(?:被)?关|没被关|仍(?:然)?(?:在|开)|还(?:在|开|是开))',
    '(?:保留|留着|留下|保持)(?:了|着)?(?:这个|该|当前|此)?(?:窗口|页面|结果页|浏览器)',
    '(?:window|page|tab|browser)[^.!?\\n]{0,30}(?:\\b(?:is|was|stays?|remains?|kept|left)\\b[^.!?\\n]{0,10}(?:open|kept)|not (?:been )?closed|still open)',
  ].join('|'),
  'i',
);

const HONEST_DENIAL_RE =
  /已(?:经)?(?:被)?关(?:闭|掉|了)|窗口已关|(?:没|未|无法|不能|没能|未能)(?:能|有)?(?:成功)?保留|(?:was|been|is|now|already) closed|(?:could not|couldn't|cannot|can't|unable to|failed to) keep|not (?:been )?kept|no longer open|isn't open/i;

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
  if (!content.trim() || !KEEP_CLAIM_RE.test(content)) return { action: 'none', content };

  const browserContext = input.usedBrowserTool
    || (input.recentUserMessages ?? []).some((text) => BROWSER_CONTEXT_RE.test(text));
  if (!browserContext) return { action: 'none', content };

  const { getKeptBrowserRegistry } = await import('../../services/surfaceExecution/keptBrowserRegistry');
  if (getKeptBrowserRegistry().snapshot(input.sessionId).state === 'kept') return { action: 'none', content };
  if (HONEST_DENIAL_RE.test(content)) return { action: 'none', content };

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
