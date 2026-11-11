import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where a path really lands, even when its tail (or a link's target) does not exist yet:
 * a data dir that has never been created must still be recognised behind a symlink.
 */
function resolveThroughLinks(target: string, hops = 0): string {
  if (hops > 32) throw new Error('verification data directory has a symlink loop');
  const pending: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() && !existsSync(current)) {
      const linked = path.resolve(path.dirname(current), readlinkSync(current));
      return resolveThroughLinks(path.join(linked, ...pending), hops + 1);
    }
    if (stat) return path.join(realpathSync(current), ...pending);
    const parent = path.dirname(current);
    if (parent === current) return path.join(current, ...pending);
    pending.unshift(path.basename(current));
    current = parent;
  }
}

/** Verification clients must never operate on a resident owner's data directory. */
export function assertIsolatedVerificationDir(dataDir: string | undefined): string {
  if (!dataDir) throw new Error('verification requires an explicit isolated CODE_AGENT_DATA_DIR');
  const resolved = resolveThroughLinks(dataDir);
  const home = realpathSync(os.homedir());
  if (path.dirname(resolved) === home && /^\.code-agent(?:-dev\d*|-chatprobe)?$/.test(path.basename(resolved))) {
    throw new Error('verification refuses a live data directory; start verify-slotless or neo-realrun first');
  }
  return resolved;
}

/** No store is needed: model credentials are supplied by the staged config.json.
 * Reject the entire pair, including malformed/opaque stores and symlinks, rather
 * than trusting a decryption failure as proof that it contains no login session.
 */
export function assertNoLoginSession(dataDir: string): void {
  for (const file of ['secure-storage.json', '.secure-key']) {
    if (lstatSync(path.join(dataDir, file), { throwIfNoEntry: false })) {
      throw new Error('staged secure storage may carry a login session; refused before server start (use --copy-login-session explicitly)');
    }
  }
}

/** A data dir alone does not isolate the macOS session Keychain. */
export function isolatedVerificationEnv(dataDir: string): NodeJS.ProcessEnv {
  return { HOME: dataDir, CODE_AGENT_HOME: dataDir };
}
