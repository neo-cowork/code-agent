import type { ElementHandle, Page } from 'playwright';

interface BrowserSubmitClickProbeResult {
  status: 'known';
  isSubmit: boolean;
  method: string | null;
  actionCrossOrigin: boolean;
  targetHost: string | null;
}

interface BrowserSubmitClickProbeUnknown {
  status: 'unknown';
  cause: string;
}

export type BrowserSubmitClickProbeOutcome =
  | BrowserSubmitClickProbeResult
  | BrowserSubmitClickProbeUnknown;

export type BrowserSubmitClickTarget =
  | { selector: string }
  | { text: string }
  | { point: { x: number; y: number } };

function inspectSubmitControl(element: Element): BrowserSubmitClickProbeResult {
  const control = element.closest('button, input');
  let submitter: HTMLButtonElement | HTMLInputElement | null = null;
  if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) {
    submitter = control;
  }
  const isButton = submitter instanceof HTMLButtonElement;
  const isInput = submitter instanceof HTMLInputElement;
  const inputType = submitter?.type.toLowerCase() || '';
  const isSubmitControl = isButton
    ? inputType === 'submit'
    : isInput && (inputType === 'submit' || inputType === 'image');
  const form = submitter?.form;
  if (!isSubmitControl || !submitter || !form) {
    return {
      status: 'known',
      isSubmit: false,
      method: null,
      actionCrossOrigin: false,
      targetHost: null,
    };
  }

  const method = (
    submitter.hasAttribute('formmethod') ? submitter.formMethod : form.method
  ).toUpperCase() || 'GET';
  const action = submitter.hasAttribute('formaction') ? submitter.formAction : form.action;
  const actionUrl = new URL(action || document.URL, document.baseURI);
  return {
    status: 'known',
    isSubmit: true,
    method,
    actionCrossOrigin: actionUrl.origin !== window.location.origin,
    targetHost: actionUrl.host || window.location.host || 'unknown',
  };
}

async function resolveTargetHandle(
  page: Page,
  target: BrowserSubmitClickTarget,
): Promise<ElementHandle<Element> | null> {
  if ('selector' in target) return await page.$(target.selector);
  if ('text' in target) return await page.$(`text=${target.text}`);

  const handle = await page.evaluateHandle(
    ({ x, y }) => document.elementFromPoint(x, y),
    target.point,
  );
  const element = handle.asElement() as ElementHandle<Element> | null;
  if (!element) await handle.dispose();
  return element;
}

export async function probeBrowserSubmitClick(
  page: Page,
  target: BrowserSubmitClickTarget,
): Promise<BrowserSubmitClickProbeOutcome> {
  let element: ElementHandle<Element> | null = null;
  try {
    element = await resolveTargetHandle(page, target);
    if (!element) {
      return { status: 'unknown', cause: 'click target did not resolve to a live element' };
    }
    return await element.evaluate(inspectSubmitControl);
  } catch (error) {
    return {
      status: 'unknown',
      cause: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await element?.dispose().catch(() => undefined);
  }
}
