import { NOTIFICATION_BUDGET } from '../../../shared/constants';
import type { NotificationIntent } from './notificationPolicy';

export interface NotificationBudgetItem {
  intent: NotificationIntent;
  urgent?: boolean;
  title: string;
  sessionId: string;
}

export interface NotificationBudgetTimer {
  unref?: () => void;
}

interface NotificationBudgetOptions<T extends NotificationBudgetItem> {
  deliver: (item: T) => void;
  deliverDigest: (items: readonly T[]) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => NotificationBudgetTimer;
  clearTimer?: (timer: NotificationBudgetTimer) => void;
  /** 暂存队列变化（新增暂存 / 窗口收尾 / clear）时回调，用于落盘；dispose 不触发。 */
  onHeldChange?: (held: readonly T[]) => void;
}

/** enqueue 的去向：立即投递（豁免/开窗首条）还是暂存等窗口收尾。 */
export type NotificationBudgetDisposition = 'delivered' | 'held';

export class NotificationBudget<T extends NotificationBudgetItem> {
  private readonly deliver: (item: T) => void;
  private readonly deliverDigest: (items: readonly T[]) => void;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => NotificationBudgetTimer;
  private readonly clearTimer: (timer: NotificationBudgetTimer) => void;
  private readonly onHeldChange: ((held: readonly T[]) => void) | undefined;
  private held: T[] = [];
  private timer: NotificationBudgetTimer | undefined;
  private windowStartedAt: number | null = null;

  constructor(options: NotificationBudgetOptions<T>) {
    this.deliver = options.deliver;
    this.deliverDigest = options.deliverDigest;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.onHeldChange = options.onHeldChange;
    this.clearTimer = options.clearTimer ?? ((timer) => {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    });
  }

  enqueue(item: T): NotificationBudgetDisposition {
    if (item.intent === 'needs_input' || item.intent === 'task_failed' || item.urgent === true) {
      this.deliver(item);
      return 'delivered';
    }
    if (this.windowStartedAt === null) {
      this.deliver(item);
      this.openWindow();
      return 'delivered';
    }
    this.held.push(item);
    this.onHeldChange?.(this.held);
    return 'held';
  }

  clear(): void {
    this.stop();
    this.held = [];
    this.onHeldChange?.(this.held);
  }

  /** 退出：只停定时器。暂存队列已落盘，留给下次启动补发，不能在这里清掉。 */
  dispose(): void {
    this.stop();
  }

  private stop(): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
    this.windowStartedAt = null;
  }

  private openWindow(): void {
    this.windowStartedAt = this.now();
    this.timer = this.setTimer(() => this.flushWindow(), NOTIFICATION_BUDGET.WINDOW_MS);
    this.timer.unref?.();
  }

  private flushWindow(): void {
    const held = this.held;
    this.timer = undefined;
    this.windowStartedAt = null;
    this.held = [];
    if (held.length === 0) return;
    this.onHeldChange?.(this.held);
    if (held.length === 1) {
      this.deliver(held[0]);
      return;
    }
    this.deliverDigest(held);
    this.openWindow();
  }
}
