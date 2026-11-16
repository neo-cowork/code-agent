export type SessionTaskSlotLocale = 'zh' | 'en';

function durationText(durationMs: number, locale: SessionTaskSlotLocale): string {
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  if (seconds < 60) return locale === 'zh' ? `${seconds} 秒` : `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return locale === 'zh' ? `${minutes} 分钟` : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return locale === 'zh' ? `${hours} 小时` : `${hours} hour${hours === 1 ? '' : 's'}`;
}

const messages = {
  zh: {
    detail: (taskLabel: string, duration: string) => (
      `「${taskLabel}」已经 ${duration}没有进展，可能中途异常退出，我已把它标记为失败。`
    ),
    screen: '任务长时间没有回报结束状态，系统已释放它占用的任务队列，请重试',
    spoken: '任务长时间没有回报结束状态，系统已经释放任务队列。这件事没有完成，请重试。',
  },
  en: {
    detail: (taskLabel: string, duration: string) => (
      `“${taskLabel}” has made no progress for ${duration} and may have stopped unexpectedly. I’ve marked it as failed.`
    ),
    screen: 'The task has made no progress for a long time. Please retry',
    spoken: 'The task has made no progress for a long time. It did not finish. Please retry.',
  },
} as const;

const idleFailure = {
  zh: (duration: string) => `后台任务失败：命令已 ${duration}没有响应`,
  en: (duration: string) => `Background task failed: the command stopped responding for ${duration}`,
} as const;

/** 未答审批等到上限的失败句：说清是「等你批准等太久」，不是任务本身没响应。 */
const approvalWaitFailure = {
  zh: (duration: string) => `后台任务失败：等待你的批准已超过 ${duration}，已取消并释放任务位，可重试`,
  en: (duration: string) => `Background task failed: waited more than ${duration} for your approval, cancelled`,
} as const;

export function formatSessionTaskSlotRecoveryDetail(input: {
  taskLabel: string;
  occupiedMs: number;
  locale: SessionTaskSlotLocale;
}): string {
  return messages[input.locale].detail(
    input.taskLabel,
    durationText(input.occupiedMs, input.locale),
  );
}

export function describeSessionTaskSlotRecovery(locale: SessionTaskSlotLocale): {
  screen: string;
  spoken: string;
} {
  return messages[locale];
}

/** 回收时在途命令可能在等 macOS 系统授权框：框由系统持有、Neo 关不掉，只能提示用户手动处理。 */
const systemPromptHint = {
  zh: '系统授权框可能还在屏幕上，请手动点掉或点「不允许」。',
  en: 'A system permission prompt may still be on screen; dismiss it or choose Don\'t Allow.',
} as const;

export function getSystemPromptHint(locale: SessionTaskSlotLocale): string {
  return systemPromptHint[locale];
}

const automationPromptTimeoutHint = {
  zh: `这条命令在等一个没人点的 macOS「自动化」授权框，已超时。请在「系统设置」>「隐私与安全性」>「自动化」中允许 Agent Neo 控制相应应用，然后重跑。${systemPromptHint.zh}`,
  en: `This command was waiting for an unanswered macOS Automation prompt and timed out. In System Settings > Privacy & Security > Automation, allow Agent Neo to control the app, then rerun. ${systemPromptHint.en}`,
} as const;

export function withAutomationPromptTimeoutHint(
  text: string,
  locale: SessionTaskSlotLocale,
  flag?: boolean,
): string {
  if (!flag) return text;
  const separator = locale === 'zh' ? '' : ' ';
  return `${automationPromptTimeoutHint[locale]}${separator}${text}`;
}

function withSystemPromptHint(text: string, locale: SessionTaskSlotLocale, flag?: boolean): string {
  return flag ? `${text}${locale === 'zh' ? '。' : '. '}${getSystemPromptHint(locale)}` : text;
}

export function formatSessionCommandTaskIdleFailure(input: {
  idleMs: number;
  locale: SessionTaskSlotLocale;
  mayAwaitSystemPrompt?: boolean;
}): string {
  return withSystemPromptHint(
    idleFailure[input.locale](durationText(input.idleMs, input.locale)),
    input.locale,
    input.mayAwaitSystemPrompt,
  );
}

export function formatSessionTaskApprovalWaitFailure(input: {
  waitMs: number;
  locale: SessionTaskSlotLocale;
  mayAwaitSystemPrompt?: boolean;
}): string {
  return withSystemPromptHint(
    approvalWaitFailure[input.locale](durationText(input.waitMs, input.locale)),
    input.locale,
    input.mayAwaitSystemPrompt,
  );
}
