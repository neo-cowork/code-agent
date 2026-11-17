import type { Message } from '@shared/contract';
import type { TraceNode, TraceTurn } from '@shared/contract/trace';
import { classifyAgentError } from '@shared/utils/agentErrorClassification';
import { failureRunStep, isSuccessfulAssistantReply, type FailureRun } from './failureRun';

type Round = { userId?: string; messages: Message[]; childErrors: Set<string>; started: Set<string> };

/** Project failures onto visible turns, without changing persisted messages or parent replies. */
export function projectAgentErrorRuns(messages: Message[], turns: TraceTurn[]) {
  const rounds: Round[] = [];
  const taskOwners = new Map<string, Round>();
  const callOwners = new Map<string, Round>();
  let round: Round = { messages: [], childErrors: new Set(), started: new Set() };
  rounds.push(round);
  let internalInput = false;
  for (const message of messages) {
    if (message.role === 'user' && !message.isMeta) {
      round = { userId: message.id, messages: [], childErrors: new Set(), started: new Set() };
      rounds.push(round);
      internalInput = false;
    } else if (message.role === 'user' && message.isMeta) {
      internalInput = true;
    }
    round.messages.push(message);
    if (internalInput && message.metadata?.agentError?.category === 'rate_limited') round.childErrors.add(message.id);
    for (const call of message.toolCalls ?? []) {
      if (call.name === 'delegate_task') {
        callOwners.set(call.id, round);
        round.started.add(call.id);
      }
    }
    // Accepted results bind asynchronous completions to the turn that started the task,
    // even when the user has already sent another message before completion arrives.
    for (const result of message.toolResults ?? []) {
      const owner = callOwners.get(result.toolCallId);
      const sessionTask = result.metadata?.sessionTask as
        { outcome?: string; tasks?: { taskId?: string }[] } | undefined;
      if (owner && sessionTask?.outcome === 'accepted') {
        owner.started.delete(result.toolCallId);
        for (const task of sessionTask.tasks ?? []) {
          if (task.taskId) { owner.started.add(task.taskId); taskOwners.set(task.taskId, owner); }
        }
      } else if (owner && result.success === false) {
        owner.started.delete(result.toolCallId);
      }
    }
  }
  const resultsByRound = new Map<Round, Map<string, Message>>();
  for (const current of rounds) {
    for (const message of current.messages) {
      const result = message.metadata?.backgroundTaskResult;
      if (!result || message.role !== 'system') continue;
      const owner = taskOwners.get(result.taskId) ?? current;
      const results = resultsByRound.get(owner) ?? new Map<string, Message>();
      results.set(result.taskId, message);
      resultsByRound.set(owner, results);
    }
  }
  const nodesByMessage = new Map<string, TraceNode[]>();
  const turnsByUser = new Map<string, TraceTurn>();
  for (const turn of turns) {
    for (const node of turn.nodes) {
      if (node.type === 'user') turnsByUser.set(node.id, turn);
      if (node.metadata?.agentError) {
        const key = node.messageId ?? node.id;
        const nodes = nodesByMessage.get(key) ?? [];
        nodes.push(node);
        nodesByMessage.set(key, nodes);
      }
    }
  }
  let runNode: TraceNode | undefined;
  let run: FailureRun | undefined;
  for (const current of rounds) {
    const results = resultsByRound.get(current);
    const background = Boolean(results?.size || current.started.size);
    const errors: TraceNode[] = [];
    for (const message of current.messages) {
      const nodes = nodesByMessage.get(message.id) ?? [];
      if (background && current.childErrors.has(message.id)) {
        // Child errors are represented by the task aggregate, including on success.
        for (const node of nodes) node.metadata = { ...node.metadata, agentError: undefined };
      } else errors.push(...nodes);
    }
    const resultMessages = [...(results?.values() ?? [])];
    const lastResult = resultMessages.at(-1);
    const allRateLimited = resultMessages.length > 0
      && [...current.started].every(id => results?.has(id))
      && resultMessages.every(message => {
        const result = message.metadata?.backgroundTaskResult;
        return result?.status === 'failed' && classifyAgentError({ message: result.summary })?.category === 'rate_limited';
      });
    const successfulReply = current.messages.some(message => isSuccessfulAssistantReply(message)
      && (!lastResult || message.timestamp > lastResult.timestamp));
    const backgroundError = lastResult?.metadata?.backgroundTaskResult
      ? classifyAgentError({ message: lastResult.metadata.backgroundTaskResult.summary }) : null;
    if (!errors.length && allRateLimited && !successfulReply && lastResult && backgroundError && current.userId) {
      const turn = turnsByUser.get(current.userId);
      if (turn) {
        const retryAnchor = current.messages.findLast(message => message.role !== 'user')?.id ?? lastResult.id;
        // Keep terminal progress and its outcome in one presentation node so the
        // existing TurnCard final-text slot retains the line when history folds.
        // Only pre-failure progress is coalesced; persisted parent replies stay intact.
        const progress = turn.nodes.findLast(node => node.type === 'assistant_text' && node.content.trim()
          && !node.metadata?.agentError && node.timestamp <= lastResult.timestamp);
        const node: TraceNode = { ...progress, id: `${lastResult.id}-rate-limit`, messageId: retryAnchor,
          type: 'assistant_text', content: progress?.content ?? '', timestamp: lastResult.timestamp,
          metadata: { ...progress?.metadata, agentError: { ...backgroundError, timestamp: lastResult.timestamp } } };
        if (progress) turn.nodes.splice(turn.nodes.indexOf(progress), 1);
        turn.nodes.push(node);
        errors.push(node);
      }
    }
    let firstFailure = true;
    for (const node of errors) {
      const category = node.metadata?.agentError?.category;
      if (!category) continue;
      const step = failureRunStep(run, { type: 'failure', cause: category, id: node.id });
      if (step.supersededId !== undefined && runNode && run) {
        runNode.agentErrorRun = { runLength: run.runLength, latest: false, ...(!firstFailure ? { duplicate: true } : {}) };
        // Duplicate reports in one round still represent only one failure.
        if (!firstFailure && step.run) step.run.runLength = run.runLength;
      }
      run = step.run;
      if (run) node.agentErrorRun = { runLength: run.runLength, latest: true };
      runNode = node;
      firstFailure = false;
    }
    if (!errors.length && successfulReply) {
      run = failureRunStep(run, { type: 'reset' }).run;
      if (!run) runNode = undefined;
    }
  }
}
