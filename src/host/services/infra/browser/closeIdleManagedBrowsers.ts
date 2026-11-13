import { browserPool } from '../browserPool';
import { createLogger } from '../logger';
import { hasManagedBrowserActivity } from './managedBrowserActivity';

const logger = createLogger('IdleManagedBrowsers');

/** Synchronous lease check + bounded SIGTERM; never wait for Playwright close or a drain. */
export function closeIdleManagedBrowsers(reason: 'shell-exit-resident' | 'residency-idle' | 'shutdown'): {
  closed: number;
  skipped: Array<{ key: string; reason: 'in-use' | 'no-managed-process' }>;
} {
  let closed = 0;
  const skipped: Array<{ key: string; reason: 'in-use' | 'no-managed-process' }> = [];
  for (const { key, service, inUse } of browserPool.managedServices()) {
    // Pool occupancy is an additional guard; the service checks its lease too,
    // including __default__, which has no pool occupancy flag.
    const outcome = inUse || hasManagedBrowserActivity(service) ? 'in-use' : service.terminateIdleManagedProcess();
    if (outcome === 'terminated') closed += 1;
    else skipped.push({ key, reason: outcome });
  }
  logger.info(`[managed-browser.idle-close] reason=${reason} closed=${closed} skipped-because-in-use=${skipped.filter((entry) => entry.reason === 'in-use').length} skipped=${JSON.stringify(skipped)}`);
  return { closed, skipped };
}
