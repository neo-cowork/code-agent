/** Closing copy for background work that stopped before returning a final result. */
export function formatBackgroundTaskStop(input: {
  lastPage?: string;
  stepCap?: { iterations: number; maxIterations: number };
}): string {
  const where = input.lastPage ? `最后停留在页面${input.lastPage}，` : '';
  const { stepCap } = input;
  const conclusion = stepCap
    ? `后台任务做到第 ${stepCap.iterations} 步（上限 ${stepCap.maxIterations} 步）就用完了步数，${where}还没有得出最终结果。`
    : `后台任务停下来了，${where}但没有留下最终结果。`;
  return `${conclusion}你可以回复「继续」让它接着做，或者把任务缩小一些再试一次。`;
}
