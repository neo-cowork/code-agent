import type { ToolExecutionResult } from '../types';
import { BROWSER_TIMEOUTS } from '../../../shared/constants/timeouts';
import type { BrowserService, ElementInfo } from '../../services/infra/browserService.js';

const CONSECUTIVE_FAILURE_STOP_THRESHOLD = 2;

interface SelectorFailureState {
  selector: string;
  streak: number;
  lastUrl: string;
}

const selectorFailuresByBrowser = new WeakMap<BrowserService, Map<string, SelectorFailureState>>();

function resolveTabKey(browserService: BrowserService, tabId?: string): string | null {
  if (tabId) return tabId;
  try {
    return browserService.getActiveTab()?.id ?? null;
  } catch {
    return null;
  }
}

function getLiveUrl(browserService: BrowserService, tabId?: string): string {
  try {
    return browserService.getLiveTabUrl(tabId);
  } catch {
    return '';
  }
}

function getOrCreateFailureState(
  browserService: BrowserService,
  tabId?: string,
): { state: SelectorFailureState | null; currentUrl: string } {
  const tabKey = resolveTabKey(browserService, tabId);
  const currentUrl = getLiveUrl(browserService, tabId);
  if (!tabKey) {
    return { state: null, currentUrl };
  }
  let states = selectorFailuresByBrowser.get(browserService);
  if (!states) {
    states = new Map();
    selectorFailuresByBrowser.set(browserService, states);
  }
  let state = states.get(tabKey);
  if (!state) {
    state = { selector: '', streak: 0, lastUrl: currentUrl };
    states.set(tabKey, state);
  } else if (currentUrl && state.lastUrl && currentUrl !== state.lastUrl) {
    state.selector = '';
    state.streak = 0;
    state.lastUrl = currentUrl;
  }
  return { state, currentUrl };
}

export function resetBrowserSelectorFillStreak(browserService: BrowserService, tabId?: string): void {
  const { state, currentUrl } = getOrCreateFailureState(browserService, tabId);
  if (!state) return;
  state.selector = '';
  state.streak = 0;
  state.lastUrl = currentUrl;
}

function checkThirdCallGuard(
  state: SelectorFailureState | null,
  selector: string,
  action = 'fill',
): ToolExecutionResult | null {
  if (!state) return null;
  if (state.selector === selector && state.streak >= CONSECUTIVE_FAILURE_STOP_THRESHOLD) {
    state.streak += 1;
    return {
      success: false,
      error:
        `Selector ${action} stopped: "${selector}" has already failed ${CONSECUTIVE_FAILURE_STOP_THRESHOLD} consecutive times in this tab. ` +
        `Do not retry this selector. Take a snapshot with browser_action.get_dom_snapshot and use a targetRef for a visible element, ` +
        `or construct the search URL directly with browser_action.navigate.`,
    };
  }
  return null;
}

function noteSelectorSuccess(
  state: SelectorFailureState | null,
  currentUrl: string,
): void {
  if (!state) return;
  state.selector = '';
  state.streak = 0;
  state.lastUrl = currentUrl;
}

function noteSelectorFailure(
  state: SelectorFailureState | null,
  selector: string,
  currentUrl: string,
): void {
  if (!state) return;
  if (state.selector === selector) {
    state.streak += 1;
  } else {
    state.selector = selector;
    state.streak = 1;
  }
  if (currentUrl) {
    state.lastUrl = currentUrl;
  }
}

interface SelectorDomDiagnostics {
  matchCount: number;
  visibleCount: number;
  notEditable: boolean;
  innerWidth: number | null;
}

async function inspectSelectorFailureOnPage(
  browserService: BrowserService,
  selector: string,
  tabId?: string,
): Promise<SelectorDomDiagnostics> {
  const fallbackWidth = (() => {
    try {
      const vp = browserService.getSessionState?.()?.viewport;
      return typeof vp?.width === 'number' ? vp.width : null;
    } catch {
      return null;
    }
  })();

  try {
    const encodedSelector = JSON.stringify(selector);
    return await browserService.runScript<SelectorDomDiagnostics>(`(() => {
      const sel = ${encodedSelector};
      const innerWidth = typeof window !== 'undefined' ? window.innerWidth : null;
      let elements = [];
      try {
        if (sel.startsWith('text=')) {
          const text = sel.slice(5).replace(/\\s+/g, ' ').trim();
          const normalized = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
          elements = Array.from(document.querySelectorAll('body *')).filter((el) =>
            !['SCRIPT', 'STYLE'].includes(el.tagName) && normalized(el).includes(text) &&
            !Array.from(el.children).some((child) => normalized(child).includes(text)));
        } else {
          elements = Array.from(document.querySelectorAll(sel));
        }
      } catch {
        return { matchCount: -1, visibleCount: 0, notEditable: false, innerWidth };
      }
      const matchCount = elements.length;
      if (matchCount === 0) {
        return { matchCount: 0, visibleCount: 0, notEditable: false, innerWidth };
      }
      let visibleCount = 0;
      let notEditable = false;
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.visibility !== 'collapse' &&
          rect.width > 0 &&
          rect.height > 0;
        if (visible) visibleCount += 1;
        const htmlEl = el;
        const tag = el.tagName.toLowerCase();
        const editableTag = tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
        if (htmlEl.disabled || htmlEl.readOnly || !editableTag) {
          notEditable = true;
        }
      }
      return { matchCount, visibleCount, notEditable, innerWidth };
    })()`, tabId);
  } catch {
    return { matchCount: -1, visibleCount: 0, notEditable: false, innerWidth: fallbackWidth };
  }
}

async function formatSelectorFillError(args: {
  browserService: BrowserService;
  selector: string;
  error: unknown;
  tabId?: string;
  action?: 'fill' | 'click';
}): Promise<string> {
  const { browserService, selector, error, tabId, action = 'fill' } = args;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const diag = await inspectSelectorFailureOnPage(browserService, selector, tabId);
  const width = diag.innerWidth;
  const widthNote = width !== null
    ? ` (current innerWidth=${width}px; the page may be showing a narrow/compact layout)`
    : ' (the page may be showing a narrow/compact layout)';
  const nextStep =
    'Take a snapshot with browser_action.get_dom_snapshot and use a targetRef for a visible element, ' +
    'or construct the search URL directly with browser_action.navigate.';

  if (/strict mode violation|resolved to \d+ elements/i.test(rawMessage) || diag.matchCount > 1) {
    const countLabel = diag.matchCount > 1 ? ` (${diag.matchCount} matches)` : '';
    const hiddenNote = diag.visibleCount === 0 ? widthNote : '';
    return `Cannot ${action} selector "${selector}": found several matching elements${countLabel}${hiddenNote}. ${nextStep}`;
  }

  if (
    action === 'fill' && (/not editable|not an <input>|disabled|readonly|read-only|not fillable|cannot be filled/i.test(rawMessage) ||
    (diag.matchCount === 1 && diag.notEditable))
  ) {
    const hiddenNote = diag.visibleCount === 0 ? widthNote : '';
    return `Cannot fill selector "${selector}": element is not editable (disabled, read-only, or not a text input)${hiddenNote}. ${nextStep}`;
  }

  if (diag.matchCount === 1 && diag.visibleCount === 0) {
    return `Cannot ${action} selector "${selector}": element found but not visible${widthNote}. ${nextStep}`;
  }

  if (diag.matchCount === 0) {
    return `Cannot ${action} selector "${selector}": element not found on the current page. ${nextStep}`;
  }

  if (/not visible|hidden/i.test(rawMessage)) {
    return `Cannot ${action} selector "${selector}": element found but not visible${widthNote}. ${nextStep}`;
  }

  if (action === 'click') {
    return `Cannot click selector "${selector}": element is not actionable (disabled, covered, or unstable). ${nextStep}`;
  }

  return `Cannot fill selector "${selector}": element not found or not visible within timeout${widthNote}. ${nextStep}`;
}

export async function executeSelectorClickWithFastFail(args: {
  browserService: BrowserService;
  selector: string;
  tabId?: string;
}): Promise<ToolExecutionResult> {
  const { browserService, selector, tabId } = args;
  const { state, currentUrl } = getOrCreateFailureState(browserService, tabId);
  const guarded = checkThirdCallGuard(state, selector, 'click');
  if (guarded) return guarded;
  try {
    const boundingBox = selector.startsWith('text=')
      ? (await browserService.findElementByText(selector.slice(5), tabId))?.rect ?? null
      : await browserService.getElementBoundingBox(selector, tabId);
    await browserService.click(selector, tabId, BROWSER_TIMEOUTS.FILL_SELECTOR);
    noteSelectorSuccess(state, getLiveUrl(browserService, tabId) || currentUrl);
    return { success: true, output: `Clicked element: ${selector}`,
      metadata: { pointerTarget: { label: selector, selector, boundingBox } } };
  } catch (error) {
    noteSelectorFailure(state, selector, currentUrl);
    return { success: false, error: await formatSelectorFillError({ ...args, error, action: 'click' }) };
  }
}

export async function executeSelectorTypeWithFastFail(args: {
  browserService: BrowserService;
  selector: string;
  text: string;
  tabId?: string;
}): Promise<ToolExecutionResult> {
  const { browserService, selector, text, tabId } = args;
  const { state, currentUrl } = getOrCreateFailureState(browserService, tabId);

  const guarded = checkThirdCallGuard(state, selector);
  if (guarded) return guarded;

  try {
    await browserService.type(selector, text, tabId);
    noteSelectorSuccess(state, getLiveUrl(browserService, tabId) || currentUrl);
    let boundingBox: ElementInfo['rect'] | null = null;
    try {
      boundingBox = await browserService.getElementBoundingBox(selector, tabId);
    } catch {
      boundingBox = null;
    }
    return {
      success: true,
      output: `Typed ${text.length} chars into ${selector}`,
      metadata: {
        pointerTarget: {
          label: selector,
          selector,
          boundingBox,
        },
      },
    };
  } catch (error) {
    noteSelectorFailure(state, selector, currentUrl);
    const formatted = await formatSelectorFillError({ browserService, selector, error, tabId });
    return {
      success: false,
      error: formatted,
    };
  }
}

export async function executeFillFormWithFastFail(args: {
  browserService: BrowserService;
  formData: Record<string, string>;
  tabId?: string;
}): Promise<ToolExecutionResult> {
  const { browserService, formData, tabId } = args;
  const entries = Object.entries(formData);

  for (const [selector, value] of entries) {
    const { state, currentUrl } = getOrCreateFailureState(browserService, tabId);
    const guarded = checkThirdCallGuard(state, selector);
    if (guarded) return guarded;
    try {
      await browserService.fillForm({ [selector]: value }, tabId);
      noteSelectorSuccess(state, getLiveUrl(browserService, tabId) || currentUrl);
    } catch (error) {
      noteSelectorFailure(state, selector, currentUrl);
      const formatted = await formatSelectorFillError({ browserService, selector, error, tabId });
      return {
        success: false,
        error: formatted,
      };
    }
  }

  const fields = Object.keys(formData).join(', ');
  return { success: true, output: `Filled form fields: ${fields}` };
}
