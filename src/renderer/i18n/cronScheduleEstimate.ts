export const cronScheduleEstimateZh = {
  cronScheduleEstimate: {
    label: '运行估算',
    about: (count: number) => `每天约 ${count} 次`,
    atMost: (count: number) => `每天最多约 ${count} 次`,
    lessThanDaily: '不到每天一次',
    shortestGap: (count: string) => `${count}（按最短间隔估算）`,
    usd: (cost: string) => `每天约 ${cost}`,
    flatFee: '不按美元计费',
    unknown: '无法提前估算费用，如需付费则按实际用量计',
    frequent: '每次运行都会调用你的模型并消耗模型额度。运行间隔越短，额度消耗越快。',
    frequentWithoutModel: '运行间隔越短，任务运行越频繁。',
  },
};

export const cronScheduleEstimateEn = {
  cronScheduleEstimate: {
    label: 'Run estimate',
    about: (count: number) => `About ${count} ${count === 1 ? 'run' : 'runs'}/day`,
    atMost: (count: number) => `At most about ${count} ${count === 1 ? 'run' : 'runs'}/day`,
    lessThanDaily: 'Less than one run/day',
    shortestGap: (count: string) => `${count}, based on the shortest gap between runs`,
    usd: (cost: string) => `about ${cost}/day`,
    flatFee: 'not billed in USD',
    unknown: 'cost cannot be estimated up front. Any charges are based on actual usage',
    frequent: 'Each run calls your model and uses your model quota. Shorter intervals use it faster.',
    frequentWithoutModel: 'Shorter intervals make this task run more often.',
  },
};

export function formatScheduleRunCount(
  copy: typeof cronScheduleEstimateEn.cronScheduleEstimate,
  { runsPerDay, exact }: { runsPerDay: number; exact: boolean },
): string {
  const count = runsPerDay < 1
    ? copy.lessThanDaily
    : exact ? copy.about(runsPerDay) : copy.atMost(runsPerDay);
  return exact ? count : copy.shortestGap(count);
}
