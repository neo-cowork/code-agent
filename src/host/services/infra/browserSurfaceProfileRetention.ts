import * as path from 'path';
import { getUserDataPath } from '../../platform/appPaths';
import { createLogger } from './logger';
import { sweepSurfaceBrowserProfiles } from './browser/surfaceProfileSweep';

const logger = createLogger('SurfaceProfileSweep');

/** Adapts the sweep's BrowserLogger-shaped sink to the app logger so INFO lines reach the log file. */
export const surfaceProfileSweepLogger = {
  log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string): void {
    if (level === 'INFO') logger.info(message);
    else if (level === 'WARN') logger.warn(message);
    else if (level === 'ERROR') logger.error(message);
    else logger.debug(message);
  },
};

/** Once per process at startup; fire-and-forget, never blocks listen. */
export function kickoffSurfaceProfileRetention(): void {
  void sweepSurfaceBrowserProfiles({ userDataDir: getUserDataPath(), logger: surfaceProfileSweepLogger, oncePerProcess: true })
    .catch((error) => logger.warn(`Surface profile sweep failed: ${error}`));
}

/** After a non-personal surface released its browser: reclaim that surface's own dir if it is an empty shell. */
export function sweepEndedSurfaceProfile(profileDir: string | null | undefined): void {
  if (!profileDir || !path.basename(profileDir).startsWith('managed-browser-profile-surface-')) return;
  void sweepSurfaceBrowserProfiles({ userDataDir: path.dirname(profileDir), endedProfileDir: profileDir, logger: surfaceProfileSweepLogger })
    .catch((error) => logger.warn(`Surface profile sweep failed: ${error}`));
}
