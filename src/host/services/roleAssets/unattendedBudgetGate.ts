import { getBudgetService } from '../core/budgetService';
import { getHostUiLocale } from '../../config/hostUiLocale';
import { unattendedBudgetUsedUpText } from '../../../shared/i18n/unattendedBudgetUsedUp';

/** 醒来的无人值守额度已用完：message 就是写进醒来记录的那句话，不带前缀。 */
export class UnattendedBudgetUsedUpError extends Error {
  constructor() {
    super(unattendedBudgetUsedUpText(getHostUiLocale()));
    this.name = 'UnattendedBudgetUsedUpError';
  }
}

/** 醒来（含 advance goal run）花的是无人值守池；池已封顶就不再起推理。 */
export function assertUnattendedBudgetAvailable(): void {
  if (getBudgetService('unattended').shouldBlock()) throw new UnattendedBudgetUsedUpError();
}
