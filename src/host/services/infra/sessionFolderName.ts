import * as path from 'path';
import { getDefaultWorkDirectory, isLegacyDefaultWorkDirectory } from '../../config/configPaths';
import { isPlannedSessionWorkDirectory } from '../../config/sessionWorkDirectory';
import { deriveInitMemorySessionTitle } from '../../../shared/sessionTitlePlaceholder';

/** 用户自选工作目录的文件夹名；缺失或系统分配的目录（默认/旧默认/按会话规划）返回 undefined。 */
function userChosenFolderName(workingDirectory?: string): string | undefined {
  if (!workingDirectory?.trim()) return undefined;
  const resolved = path.resolve(workingDirectory.trim());
  if (
    resolved === path.resolve(getDefaultWorkDirectory())
    || isLegacyDefaultWorkDirectory(resolved)
    || isPlannedSessionWorkDirectory(resolved)
  ) return undefined;
  return path.basename(resolved) || undefined;
}

/** `/init-memory` 首条消息的确定性标题（跳过小模型）；不是该命令返回 null。语言取 UI 语言。 */
export async function initMemorySessionTitle(titleSource: string, workingDirectory?: string): Promise<string | null> {
  const { readUiLanguage } = await import('../../session/sessionTitleHostPrompt');
  return deriveInitMemorySessionTitle(titleSource, readUiLanguage(), userChosenFolderName(workingDirectory));
}
