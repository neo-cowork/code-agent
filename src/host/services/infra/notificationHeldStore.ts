// ============================================================================
// 预算窗口暂存队列的落盘（退出 / 崩溃 / kill -9 都不丢，下次启动补发一条汇总）
// 单个 JSON 文件，临时文件 + rename 原子写；读到坏文件只告警并删除，永不抛。
// ============================================================================

import fs from 'fs';
import path from 'path';
import { getUserDataPath } from '../../platform';
import { NOTIFICATION_BUDGET } from '../../../shared/constants';
import { createLogger } from './logger';
import type { NotificationBudgetItem } from './notificationBudget';

const logger = createLogger('NotificationHeldStore');

export type PersistedHeldItem = NotificationBudgetItem & {
  id: string;
  type: string;
  body: string;
  delivery: Record<string, unknown>;
  /** 首次暂存时间，仅用于补发日志里报最老一条的年龄。 */
  enqueuedAt?: number;
};

function heldFilePath(): string {
  return path.join(getUserDataPath(), NOTIFICATION_BUDGET.HELD_FILE_NAME);
}

function isPersistedItem(value: unknown): value is PersistedHeldItem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.intent === 'string' && typeof v.type === 'string' && typeof v.title === 'string'
    && typeof v.body === 'string' && typeof v.sessionId === 'string'
    && typeof v.delivery === 'object' && v.delivery !== null;
}

function removeHeldFile(): void {
  try {
    fs.rmSync(heldFilePath(), { force: true });
  } catch (error) {
    logger.warn('Failed to remove held notifications file', { reason: 'budget-persist-remove-failed', error });
  }
}

export function writeHeldFile(items: readonly PersistedHeldItem[]): void {
  if (items.length === 0) {
    removeHeldFile();
    return;
  }
  let tmp = '';
  try {
    const target = heldFilePath();
    tmp = `${target}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }), 'utf8');
    fs.renameSync(tmp, target);
  } catch (error) {
    logger.warn('Failed to persist held notifications', { reason: 'budget-persist-failed', count: items.length, error });
    if (tmp) try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

/** 读上次遗留的暂存项；文件缺失 = 空；损坏 = 告警 + 删除 + 空。 */
export function readHeldFile(): PersistedHeldItem[] {
  let raw: string;
  try {
    raw = fs.readFileSync(heldFilePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Held notifications file unreadable, removing', { reason: 'budget-persist-corrupt', error });
      removeHeldFile();
    }
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (!Array.isArray(parsed.items) || !parsed.items.every(isPersistedItem)) throw new Error('unexpected shape');
    return parsed.items;
  } catch (error) {
    logger.warn('Held notifications file corrupt, removing', { reason: 'budget-persist-corrupt', error });
    removeHeldFile();
    return [];
  }
}
