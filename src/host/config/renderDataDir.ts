import * as path from 'path';
import { CONFIG_DIR_NEW, getHomeDir, getUserConfigDir } from './configPaths';

/** Resolve model-facing default data-dir references without changing production bytes. */
export function renderDataDir(text: string): string {
  const dataDir = getUserConfigDir();
  if (path.resolve(dataDir) === path.resolve(getHomeDir(), CONFIG_DIR_NEW)) return text;
  return text.replace(/~\/\.code-agent(?=\/|$|[\s`'"<>),;:。])/g, () => dataDir.replace(/[\\/]$/, ''));
}
