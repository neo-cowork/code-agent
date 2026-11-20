// Refuse discovery of the app data folder root and the files that sit directly in it.
// Subfolders (library/, design/, skills/, memory/) stay readable. The refusal names no path.

import fs from 'fs';
import path from 'path';
import { getUserConfigDir } from '../../config/configPaths';
import type { ToolResult } from '../../protocol/tools';

const REFUSAL_CODE = 'APP_DATA_DISCOVERY_REFUSED';
const REFUSAL_TEXT =
  'This is the app\'s private data, so it cannot be listed or searched. '
  + 'To store a file in the Library, call library_add with that file. '
  + 'If that does not work, ask the user to open the Library panel and click upload.';

function canonicalExisting(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** True when the resolved path is the data dir, or a regular file directly inside it. */
function isAppDataRootDiscoveryTarget(resolvedPath: string): boolean {
  const dataDir = path.resolve(getUserConfigDir());
  const target = path.resolve(resolvedPath);
  const dataKey = canonicalExisting(dataDir) ?? dataDir;
  const targetKey = canonicalExisting(target) ?? target;
  if (targetKey === dataKey) return true;
  if (path.dirname(targetKey) !== dataKey) return false;
  try {
    return fs.statSync(targetKey).isFile();
  } catch {
    return false;
  }
}

type DiscoveryLogger = { info: (message: string, meta?: unknown) => void };

/** Return a path-free refusal, or null when this discovery target is allowed. */
export function refuseAppDataDiscovery(
  resolvedPath: string,
  logger?: DiscoveryLogger,
): ToolResult<string> | null {
  if (!isAppDataRootDiscoveryTarget(resolvedPath)) return null;
  logger?.info(REFUSAL_CODE, { code: REFUSAL_CODE });
  return { ok: false, code: REFUSAL_CODE, error: REFUSAL_TEXT };
}
