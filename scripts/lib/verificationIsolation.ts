import { existsSync, lstatSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Verification clients must never operate on a resident owner's data directory. */
export function assertIsolatedVerificationDir(dataDir: string | undefined): string {
  if (!dataDir) throw new Error('verification requires an explicit isolated CODE_AGENT_DATA_DIR');
  const resolved = existsSync(dataDir) ? realpathSync(dataDir) : path.resolve(dataDir);
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
