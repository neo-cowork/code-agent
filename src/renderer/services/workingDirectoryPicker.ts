import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from './ipcService';
import { pickNativeDirectory } from './tauriPluginFacade';
import { isTauriMode } from '../utils/platform';

export async function pickWorkingDirectory(title?: string): Promise<string | null> {
  if (isTauriMode()) {
    const dir = await pickNativeDirectory(title ? { title } : {});
    if (!dir) {
      return null;
    }
    await ipcService.invokeDomain<string | null>(IPC_DOMAINS.WORKSPACE, 'setCurrent', { dir });
    return dir;
  }
  return ipcService.invokeDomain<string | null>(IPC_DOMAINS.WORKSPACE, 'selectDirectory');
}
