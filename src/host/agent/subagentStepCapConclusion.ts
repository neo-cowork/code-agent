// ============================================================================
// 子代理步数用尽的收尾话术（N-FIX-BROWSER-TASK-CONTEXT-BLOAT-SILENT-END）
// ----------------------------------------------------------------------------
// 子代理循环按 maxIterations 退出、账本里又没有任何文字时，没有这句话用户只会看到
// 空输出。这里用已有数据（步数 / 上限 / 最后停留的页面）确定性拼一句中文结论，
// 不再多调一次模型。文案不出现工具名、id 或英文状态。
// ============================================================================

interface CapMessage {
  role: string;
  content?: unknown;
  toolCalls?: ReadonlyArray<{ arguments?: Record<string, unknown> }>;
}

const PAGE_TITLE_MAX = 40;

export function readableBrowserPage(url: string, title?: string): string {
  if (title && title !== 'New Tab') return `「${clip(title, PAGE_TITLE_MAX)}」`;
  try { return decodeURI(url); } catch { return url; }
}

export function browserPageFromOutput(output: string): string | undefined {
  const title = [...output.matchAll(/^Title: (.+)$/gmi)].pop()?.[1]?.trim();
  const url = [...output.matchAll(/^(?:URL|Navigated to): (\S+)$/gmi)].pop()?.[1];
  return title || (url && url !== 'about:blank') ? readableBrowserPage(url ?? '', title) : undefined;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 从最近的工具结果里找最后停留的页面（标题优先，其次网址；about:blank 不算）。 */
function findLastPage(messages: readonly CapMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    if (!message.content.startsWith('Tool results:')) continue;
    const titles = [...message.content.matchAll(/^Title: (.+)$/gmi)].map((m) => m[1].trim());
    const urls = [...message.content.matchAll(/^(?:URL|Navigated to): (\S+)$/gmi)]
      .map((m) => m[1])
      .filter((url) => url !== 'about:blank');
    const title = titles.filter((t) => t && t !== 'New Tab').pop();
    const url = urls.pop();
    if (title || url) return readableBrowserPage(url ?? '', title);
  }
  // 工具结果里没有页面信息（如抓取类工具）时，退回到最后一次带网址的调用入参。
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const call of [...(messages[i].toolCalls ?? [])].reverse()) {
      const url = call.arguments?.url;
      if (typeof url === 'string' && url && url !== 'about:blank') return readableBrowserPage(url);
    }
  }
  return undefined;
}

export function buildStepCapConclusion(input: {
  iterations: number;
  maxIterations: number;
  messages: readonly CapMessage[];
}): string {
  const page = findLastPage(input.messages);
  const where = page ? `最后停留在页面${page}，` : '';
  return `后台任务做到第 ${input.iterations} 步（上限 ${input.maxIterations} 步）就用完了步数，${where}还没有得出最终结果。你可以回复「继续」让它接着做，或者把任务缩小一些（比如只看其中一个网站）再试一次。`;
}
