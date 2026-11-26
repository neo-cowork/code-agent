import type { Page } from 'playwright';

const PROBE_ID = '__global-css-probe__';

/**
 * `page.setContent(..., { waitUntil: 'networkidle' })` can resolve before the
 * Vite-served Tailwind stylesheet is actually applied under CI load, so geometry
 * assertions then measure an unstyled DOM and flake. Poll a probe element whose
 * classes (`hidden`, `fixed`) only produce their computed values once
 * styles/global.css is applied, then wait for webfonts so text measurements are
 * stable. The probe is (re)created inside the poll, so a stylesheet link
 * attached late — or a later setContent wiping the body — still resolves.
 * On timeout this throws instead of letting callers measure an unstyled DOM.
 */
export async function waitForGlobalCss(page: Page, timeoutMs = 15_000): Promise<void> {
  try {
    await page.waitForFunction(
      `(() => {
        if (!document.body) return false;
        let probe = document.getElementById('${PROBE_ID}');
        if (!probe) {
          probe = document.createElement('div');
          probe.id = '${PROBE_ID}';
          probe.setAttribute('class', 'hidden fixed');
          document.body.appendChild(probe);
        }
        const style = getComputedStyle(probe);
        return style.display === 'none' && style.position === 'fixed';
      })()`,
      undefined,
      { timeout: timeoutMs },
    );
    await page.evaluate(`document.fonts.ready.then(() => undefined)`);
  } catch (error) {
    throw new Error(
      `global.css (Tailwind) was not applied within ${Math.round(timeoutMs / 1000)}s; refusing to measure an unstyled DOM (${(error as Error).message})`,
      { cause: error },
    );
  } finally {
    await page
      .evaluate(`(() => { document.getElementById('${PROBE_ID}')?.remove(); })()`)
      .catch(() => undefined);
  }
}
