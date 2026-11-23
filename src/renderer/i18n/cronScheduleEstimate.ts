export const cronScheduleEstimateZh = {
  cronScheduleEstimate: {
    label: '运行估算',
    about: (count: number) => `每天约 ${count} 次`,
    atMost: (count: number) => `每天最多约 ${count} 次`,
    lessThanDaily: '不到每天一次',
    shortestGap: (count: string) => `${count}（按最短间隔估算）`,
    usd: (cost: string) => `每天约 ${cost}`,
    flatFee: '不按美元计费',
    unknown: '首次运行后可见费用',
    frequent: '运行间隔越短，额度消耗越快。',
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
    unknown: 'cost visible after the first run',
    frequent: 'Shorter intervals use up your quota faster.',
  },
};
