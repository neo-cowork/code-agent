import type { CDPSession, Page } from 'playwright';
import { BROWSER_STAGE_VIEWPORT } from '../../../shared/constants';

type LayoutMetrics = {
  cssContentSize: { width: number };
  cssLayoutViewport: { clientWidth: number };
};

/** Match the browser health probes' four CSS pixel rounding tolerance. */
function pageOverflowsHorizontally(metrics: LayoutMetrics): boolean {
  const contentWidth = metrics.cssContentSize?.width;
  const viewportWidth = metrics.cssLayoutViewport?.clientWidth;
  if (!Number.isFinite(contentWidth) || !Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    throw new Error('Invalid CSS layout metrics');
  }
  return contentWidth > viewportWidth + 4;
}

/** Owned by one active live stream; static pages still need metadata updates. */
export class PageOverflowProbe {
  private cdp: CDPSession | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly page: Page,
    private readonly update: (overflow: boolean | undefined) => void,
    private readonly warn: (error: unknown) => void,
    private readonly isCurrent: () => boolean,
    private readonly sample: { atMs: number; value?: boolean },
  ) {}

  async start(): Promise<void> {
    if (this.stopped || !this.isCurrent()) {
      await this.stop();
      return;
    }
    const remaining = BROWSER_STAGE_VIEWPORT.OVERFLOW_SAMPLE_INTERVAL_MS - (Date.now() - this.sample.atMs);
    if (remaining > 0) {
      this.update(this.sample.value);
      this.schedule(remaining);
      return;
    }
    this.sample.atMs = Date.now();
    try {
      this.cdp ??= await this.page.context().newCDPSession(this.page);
      if (this.stopped) return;
      const metrics = await this.cdp.send('Page.getLayoutMetrics');
      if (!this.stopped) {
        this.sample.value = pageOverflowsHorizontally(metrics);
        this.update(this.sample.value);
      }
    } catch (error) {
      if (!this.stopped) {
        this.sample.value = undefined;
        this.warn(error);
        this.update(undefined);
      }
    } finally {
      if (this.stopped) {
        await this.cdp?.detach().catch(() => undefined);
      } else {
        this.schedule(BROWSER_STAGE_VIEWPORT.OVERFLOW_SAMPLE_INTERVAL_MS);
      }
    }
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => void this.start(), delayMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.cdp?.detach().catch(() => undefined);
  }
}
