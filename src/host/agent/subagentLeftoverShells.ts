import {
  BACKGROUND_COMMAND_TITLE,
  resolveBackgroundTaskTitle,
} from '../../shared/backgroundTaskTitle';
import {
  formatSubagentLeftoverShellReport,
  type SubagentLeftoverShellReportItem,
} from '../../shared/i18n/subagentLeftoverShells';
import type { SessionTaskSlotLocale } from '../../shared/i18n/sessionTaskSlot';
import { looksSandboxWrapped } from '../sandbox/wrapperMarkers';
import { getConfigService } from '../services/core/configService';
import { createLogger } from '../services/infra/logger';
import { commandMayAwaitSystemPrompt } from '../task/macosAutomationPrompt';
import {
  getAllBackgroundTasks,
  getBackgroundTaskPid,
} from '../tools/modules/shell/backgroundTaskLedger';
import { resolveBackgroundTaskName } from '../tools/modules/shell/backgroundTaskSources';

const logger = createLogger('SubagentLeftoverShells');

export type SubagentShellExitReason = 'completed' | 'cancelled' | 'failed' | 'early-failure';

function resolveLocale(executionAgentId: string): SessionTaskSlotLocale {
  try {
    return getConfigService().getSettings().ui.language;
  } catch (error) {
    logger.warn('Failed to read UI locale for leftover shell report; using Chinese fallback', {
      agentId: executionAgentId,
      message: error instanceof Error ? error.message : String(error),
    });
    return 'zh';
  }
}

export function reportSubagentLeftoverShells(
  executionAgentId: string,
  reason: SubagentShellExitReason,
): string {
  const tasks = getAllBackgroundTasks().filter(
    (task) => task.status === 'running' && task.ownerAgentId === executionAgentId,
  );
  if (tasks.length === 0) return '';
  const locale = resolveLocale(executionAgentId);
  const items: SubagentLeftoverShellReportItem[] = tasks.map((task) => {
    const reportCommand = task.displayCommand ?? task.command;
    logger.warn('Subagent ended with a background shell still running', {
      agentId: executionAgentId,
      taskId: task.taskId,
      pid: getBackgroundTaskPid(task.taskId),
      reason,
    });
    const safeDisplayName = task.displayName && !looksSandboxWrapped(task.displayName)
      ? task.displayName
      : '';
    const rawTitle = resolveBackgroundTaskName(safeDisplayName, reportCommand, locale);
    const title = resolveBackgroundTaskTitle(
      { source: 'shell', title: rawTitle },
      locale,
      BACKGROUND_COMMAND_TITLE[locale],
    );
    return {
      title,
      elapsedMs: task.duration,
      mayAwaitSystemPrompt: commandMayAwaitSystemPrompt(reportCommand),
    };
  });
  return formatSubagentLeftoverShellReport(items, locale);
}

export function appendSubagentLeftoverShellReport(text: string, report: string): string {
  if (!report) return text;
  return text ? `${text}\n\n${report}` : report;
}

export function appendSubagentLeftoverShellReportToError(error: unknown, report: string): unknown {
  if (!report) return error;
  const existingMessage = error instanceof Error ? error.message : String(error);
  const message = appendSubagentLeftoverShellReport(existingMessage, report);
  if (error instanceof Error) {
    try {
      error.message = message;
      return error;
    } catch {
      const wrapped = new Error(message, { cause: error });
      wrapped.name = error.name;
      return wrapped;
    }
  }
  return new Error(message);
}
