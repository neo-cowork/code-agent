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

/** True when a canonicalized path is the data dir itself or a regular file directly inside it. */
function isDataDirOrRootFile(targetKey: string, dataKey: string): boolean {
  if (targetKey === dataKey) return true;
  if (path.dirname(targetKey) !== dataKey) return false;
  try {
    return fs.statSync(targetKey).isFile();
  } catch {
    return false;
  }
}

/** True when the resolved path is the data dir, or a regular file directly inside it. */
function isAppDataRootDiscoveryTarget(resolvedPath: string): boolean {
  const dataDir = path.resolve(getUserConfigDir());
  const target = path.resolve(resolvedPath);
  const dataKey = canonicalExisting(dataDir) ?? dataDir;
  const targetKey = canonicalExisting(target) ?? target;
  return isDataDirOrRootFile(targetKey, dataKey);
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

/**
 * Traversal-side companion to refuseAppDataDiscovery, for when a listing or
 * search starts ABOVE the data dir (e.g. Glob/Grep from ~). Returns a predicate
 * that says whether one listed/matched path is the data dir root or a regular
 * file directly inside it — canonicalized with realpath so a symlink that
 * resolves into the data dir root is caught too. Returns null when the data
 * dir is not under the search path: callers then behave exactly as before,
 * with zero per-entry cost. Same trade as the foreign-slot result filter —
 * never an rg --glob/exclude-dir, whose bare-dir-name semantics would also
 * hide legitimate project folders that share the data dir name.
 */
export function appDataRootDiscoveryFilter(
  resolvedSearchPath: string,
): ((candidatePath: string) => boolean) | null {
  const dataDir = path.resolve(getUserConfigDir());
  const searchDir = path.resolve(resolvedSearchPath);
  const dataKey = canonicalExisting(dataDir) ?? dataDir;
  const searchKey = canonicalExisting(searchDir) ?? searchDir;
  const relative = path.relative(searchKey, dataKey);
  const dataDirUnderSearch =
    relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
  if (!dataDirUnderSearch) return null;
  return (candidatePath: string) => {
    const resolved = path.resolve(candidatePath);
    const targetKey = canonicalExisting(resolved) ?? resolved;
    return isDataDirOrRootFile(targetKey, dataKey);
  };
}
