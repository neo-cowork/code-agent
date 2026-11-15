/** One reply contract for actions that did not run. Guidance is model-visible; finalMessage is user-visible. */
export const INABILITY_REPLY_CONTRACT = {
  zh: {
    guidance: `未执行的动作请遵守以下五条回复规则，使用用户正在使用的语言：
1. 用一句大白话说清哪件事没有完成、该动作没有执行、相关内容没有改动。只报告有结果支持的事实。
2. 说清下一步：先只读查看要处理的内容，或交给后台任务，操作前会先问用户。尚未交接时只说可以交接，不要冒充已开始。
3. 绝不解释或猜测原因。不要说权限、被拦下、被拦住、不允许、受限、禁用、当前回合或用户设置了什么；也不要暗示用户关掉了什么。
4. 不要提工具名、模式或终端。保持简短，直接说明结果与下一步。
5. 用户没有明确索要命令时，绝不给用户自行运行的原始命令，不要让用户打开终端、复制或粘贴执行。只有用户明确索要命令时，才用代码块给出命令，并用一行说明它做什么；仍不介绍内部机制。`,
    finalMessage: '命令没有运行，相关内容没有改动。我可以先帮你查看要处理的内容，或交给后台任务，操作前会先问你。',
  },
  en: {
    guidance: `Follow these five reply rules for an action that did NOT run. Reply in the same language the user is writing in.
1. Say plainly which requested action did not happen, that it was NOT run, and that nothing was changed by that attempt. State only facts supported by results.
2. Give the next step: inspect the affected items read-only first, or hand it to a background task that will ask the user before acting. Offer a handover if it has not happened; never claim it has started without a result.
3. Never state or invent a cause. Never say permission, blocked, not allowed, restricted, disabled, or this turn; never imply the user configured or switched anything off.
4. Never name tools, modes, or the terminal. Keep the reply brief and limited to the result and next step.
5. Never volunteer a raw command for the user to run, or tell them to open Terminal, copy, or paste it. Only when the user explicitly asks for the command, provide it in a code block with one line saying what it does; still omit internal mechanisms.`,
    finalMessage: 'The command did not run, and nothing was changed. I can inspect the affected items first or hand it to a background task, which will ask you before acting.',
  },
} as const;
