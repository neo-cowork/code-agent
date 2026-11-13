import * as path from 'path';
import { getDefaultWorkDirectory, isLegacyDefaultWorkDirectory } from '../../host/config/configPaths';
import { isPlannedSessionWorkDirectory } from '../../host/config/sessionWorkDirectory';
import { getPromptCommandService } from '../../host/services/commands/promptCommandService';
import { createLogger } from '../../host/services/infra/logger';
import { CHOOSE_FOLDER_ENTRY_LABEL } from '../../shared/i18n/chooseFolderEntry';

const logger = createLogger('AgentSlashExpansion');

const INIT_MEMORY_NO_FOLDER_PROMPT = `Call no tools. Reply with exactly one plain sentence in the user's language saying that no folder has been chosen yet and directing them to click "${CHOOSE_FOLDER_ENTRY_LABEL.en}" (Chinese label: "${CHOOSE_FOLDER_ENTRY_LABEL.zh}") in the sidebar project area, then asking them to send /init-memory again.`;

function isSystemAssignedWorkingDirectory(workingDirectory?: string): boolean {
  if (!workingDirectory?.trim()) return false;
  const resolved = path.resolve(workingDirectory.trim());
  return resolved === path.resolve(getDefaultWorkDirectory())
    || isLegacyDefaultWorkDirectory(resolved)
    || isPlannedSessionWorkDirectory(resolved);
}

/**
 * 桌面主链 /api/run 的 "/name args" 模型面展开（appService.sendMessage 的对应物）。
 * 只改模型面文本；展示 / 持久化 / 标题仍用调用方的字面量。
 * 非命令、未注册、展开失败一律返回原文，绝不阻塞运行。
 * 注：frontmatter agent 覆盖在本路由没有等价挂点，此处不处理。
 */
export async function expandSlashPromptForModel(
  visiblePrompt: string,
  workingDirectory?: string,
): Promise<string> {
  if (!visiblePrompt.startsWith('/')) return visiblePrompt;
  try {
    const resolution = await getPromptCommandService().resolveInvocation(visiblePrompt, workingDirectory);
    if (!resolution) return visiblePrompt;
    if (resolution.name === 'init-memory' && isSystemAssignedWorkingDirectory(workingDirectory)) {
      logger.info('Skipped /init-memory expansion: working directory not chosen by user');
      return INIT_MEMORY_NO_FOLDER_PROMPT;
    }
    logger.info('Expanded prompt command', { name: resolution.name, source: resolution.source });
    return resolution.prompt;
  } catch (err) {
    logger.warn('Prompt command expansion failed; sending literal text', { error: String(err) });
    return visiblePrompt;
  }
}
