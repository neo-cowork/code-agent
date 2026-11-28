// memory 域条目动作的统一调用封装（原 MemoryEntriesManager 内部函数抽出，
// N-MEM-SOURCE-WRONG-FEEDBACK 起回复下方 MemorySourceChip 与设置面板共用）：
// 桌面态走 MEMORY 简单通道（返回 {success,data,error} 包装），失败或 web 态
// 回落 domain 通道。动作字面量集合与 shared/ipc/schemas/memory.ts 对齐。
import { IPC_CHANNELS } from '@shared/ipc';
import { IPC_DOMAINS } from '@shared/ipc/domains';
import type {
  MemoryEntryCreateRequest,
  MemoryEntryUpdateRequest,
} from '@shared/contract/memory';
import { isWebMode } from '../utils/platform';
import ipcService from './ipcService';

export type MemoryEntryCommand =
  | { action: 'memoryEntries' }
  | ({ action: 'memoryEntryCreate' } & MemoryEntryCreateRequest)
  | ({ action: 'memoryEntryUpdate' } & MemoryEntryUpdateRequest)
  | { action: 'memoryEntryBatchReview'; entryIds: string[]; decision: 'approve' | 'reject' }
  | { action: 'memoryEntryJournal'; entryId: string; limit?: number }
  | { action: 'memoryEntryResumeInjection'; entryId: string }
  | { action: 'memoryEntryFlagInjection'; entryId: string; flag: 'wrong' | 'outdated' }
  | { action: 'memoryEntryClearInjectionFlag'; entryId: string };

export interface MemoryEntryCommandResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

function isCommandResponse<T>(value: unknown): value is MemoryEntryCommandResponse<T> {
  return Boolean(value && typeof value === 'object' && 'success' in value);
}

export async function invokeMemoryEntryCommand<T>(request: MemoryEntryCommand): Promise<MemoryEntryCommandResponse<T>> {
  const commandResult = ipcService.isAvailable()
    ? await ipcService.invoke(IPC_CHANNELS.MEMORY, request) as unknown
    : undefined;
  if (commandResult !== undefined) {
    if (!isCommandResponse<T>(commandResult)) {
      return { success: true, data: commandResult as T };
    }
    if (commandResult.success || !isWebMode()) return commandResult;
  }

  try {
    const data = await ipcService.invokeDomain<T>(IPC_DOMAINS.MEMORY, request.action, request);
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
