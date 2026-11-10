import os from 'node:os';
import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { CONFIG_DIR_DEV } from '../../../shared/constants/configDir';
import { devSlotFromBundleId, devSlotFromDataDirName } from '../../../shared/devSlot';
import { createLogger } from '../infra/logger';

const logger = createLogger('FreshUserChannel');
const FRESH_USER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
let lastActiveSignature: string | null = null;

function isDevSlotDataDir(dataDir: string): boolean {
  const resolvedDataDir = resolveComparablePath(dataDir);
  const homeDir = resolveComparablePath(os.homedir());
  if (path.dirname(resolvedDataDir) !== homeDir) return false;
  const baseName = path.basename(resolvedDataDir);
  return baseName === CONFIG_DIR_DEV || devSlotFromDataDirName(baseName) !== null;
}

function resolveComparablePath(value: string): string {
  let candidate = path.resolve(value);
  const suffix: string[] = [];
  while (!existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return path.resolve(value);
    suffix.unshift(path.basename(candidate));
    candidate = parent;
  }
  return path.join(realpathSync(candidate), ...suffix);
}

/**
 * Returns the active fresh-user name, or null when the opt-in is ignored.
 * The opt-in is deliberately narrow: only a dev bundle with an explicit,
 * non-slot data directory may use it.
 */
export function getFreshUserChannelName(): string | null {
  const rawName = process.env.CODE_AGENT_FRESH_USER;
  if (rawName === undefined) return null;

  const name = rawName;
  if (!FRESH_USER_NAME_RE.test(name)) {
    logger.warn('Fresh-user channel ignored: bad name');
    return null;
  }

  const bundleId = process.env.CODE_AGENT_BUNDLE_ID?.trim();
  if (devSlotFromBundleId(bundleId) === null) {
    logger.warn('Fresh-user channel ignored: not dev bundle');
    return null;
  }

  const dataDir = process.env.CODE_AGENT_DATA_DIR?.trim();
  if (!dataDir) {
    logger.warn('Fresh-user channel ignored: no explicit data dir');
    return null;
  }
  if (isDevSlotDataDir(dataDir)) {
    logger.warn('Fresh-user channel ignored: slot dir');
    return null;
  }

  const activeSignature = `${bundleId}:${dataDir}:${name}`;
  if (activeSignature !== lastActiveSignature) {
    lastActiveSignature = activeSignature;
    logger.info('Fresh-user gate active', { name, bundleId });
  }
  return name;
}
