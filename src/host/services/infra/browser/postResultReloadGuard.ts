import type { Page } from 'playwright';
import type { BrowserTab } from './types';
import type { BrowserLogger } from './logger';

const POST_RESULT_RELOAD_ERROR = 'This page is the result of a form submission. Reloading would submit the form again, potentially creating a duplicate signup/order. Do not reload. Read the page with get_content or screenshot to check its state. If a second submission is really wanted, return to the form page, fill it in, and submit it again.';

function withoutHash(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href;
}

/** Response order follows redirects, so the final GET in PRG replaces the POST. */
export class PostResultReloadGuard {
  private readonly navigations = new WeakMap<Page, { method: string; url: string }>();

  track(page: Page): void {
    page.on('response', (response) => {
      const request = response.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        this.navigations.set(page, { method: request.method(), url: response.url() });
      }
    });
  }

  getRefusal(tab: BrowserTab, logger: BrowserLogger): string | null {
    const navigation = this.navigations.get(tab.page);
    const currentUrl = tab.page.url();
    if (navigation?.method !== 'POST' || withoutHash(navigation.url) !== withoutHash(currentUrl)) {
      return null;
    }
    logger.log('WARN', `browser_action/reload blocked POST result resubmission tab=${tab.id} origin=${new URL(currentUrl).origin}`);
    return POST_RESULT_RELOAD_ERROR;
  }
}
