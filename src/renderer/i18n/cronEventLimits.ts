// 事件自动化的两项可选限额（编辑器字段）与详情页累计一行字。
export const cronEventLimitsZh = {
  eventLimits: {
    prefilterLabel: '只处理符合这句话的消息（可选）',
    prefilterPlaceholder: '例如：只处理客户催款的消息',
    prefilterHint: '留空 = 每条消息都处理。不符合的消息会被跳过，并在处理记录里说明原因。',
    maxRunsLabel: '每小时最多运行次数',
    maxRunsPlaceholder: '默认 20',
    maxRunsHint: '用满后，新消息会等到下一个小时再处理，不会丢。',
    statsLine: '已筛选 {calls} 次，跳过 {skipped} 条，因每小时次数用满而推迟 {held} 条',
  },
};

export const cronEventLimitsEn = {
  eventLimits: {
    prefilterLabel: 'Only handle messages that match this sentence (optional)',
    prefilterPlaceholder: 'e.g. Only messages where a customer is chasing payment',
    prefilterHint: 'Leave empty to handle every message. Messages that do not match are skipped, with the reason shown in the activity list.',
    maxRunsLabel: 'Most runs per hour',
    maxRunsPlaceholder: 'Default 20',
    maxRunsHint: 'Once used up, new messages wait for the next hour instead of being lost.',
    statsLine: 'Checked {calls} times, skipped {skipped} messages, held back {held} because the hourly limit was used up',
  },
};
