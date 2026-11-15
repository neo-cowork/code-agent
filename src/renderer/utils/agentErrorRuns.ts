import type { Message, AgentErrorCategory } from '@shared/contract';
import type { AgentErrorRunInfo } from '@shared/contract/trace';

export function projectAgentErrorRuns(messages: Message[]) {
  const agentErrorRunByMessageId = new Map<string, AgentErrorRunInfo>();
  // Content in a round that eventually fails is progress, not a successful reply.
  const failedRounds = new Set<number>();
  let round = 0;
  for (const message of messages) {
    if (message.role === 'user') round += 1;
    if (message.metadata?.agentError) failedRounds.add(round);
  }
  round = 0;
  {
    // 扁平三变量而非可空对象：typescript7 对「可空对象 + `?.` 等值比较 + 显式判空」
    // 的组合会错把变量窄化成 never（隔离复现 TS2339/TS7022），扁平写法无此问题。
    let runMessageId: string | null = null;
    let runCategory: AgentErrorCategory | null = null;
    let runLength = 0;
    let sawUserSinceLastFailure = false;
    for (const msg of messages) {
      if (msg.role === 'user') {
        round += 1;
        sawUserSinceLastFailure = true;
        continue;
      }
      if (msg.role !== 'assistant') continue;
      const agentError = msg.metadata?.agentError;
      if (agentError) {
        const sameCategory = runCategory === agentError.category;
        if (sameCategory && runMessageId !== null && sawUserSinceLastFailure) {
          // 新一轮失败、同因延续：上一轮降为灰字行
          agentErrorRunByMessageId.set(runMessageId, { runLength, latest: false });
          runLength += 1;
        } else if (sameCategory && runMessageId !== null) {
          // 同一轮内的重复报错：前一条不再渲染，次数也不涨
          agentErrorRunByMessageId.set(runMessageId, { runLength, latest: false, duplicate: true });
        } else {
          runCategory = agentError.category;
          runLength = 1;
        }
        runMessageId = msg.id;
        sawUserSinceLastFailure = false;
        agentErrorRunByMessageId.set(msg.id, { runLength, latest: true });
        continue;
      }
      if (!failedRounds.has(round) && !msg.toolCalls?.length && msg.content?.trim()) {
        runCategory = null;
        runMessageId = null;
        runLength = 0;
      }
    }
  }
  return agentErrorRunByMessageId;
}
