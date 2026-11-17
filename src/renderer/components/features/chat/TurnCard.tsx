import { SkillActivityBanner } from './SkillActivityBanner';
import { isProjectTrustPendingTurn, isSendFailureTurn } from '../../../utils/projectTrustTurn';
import React, { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import type { TraceTurn, TraceNode } from '@shared/contract/trace';
import type { StreamRecoverySnapshot } from '@shared/contract/session';
import type { TurnHookActivity, TurnSkillActivity } from '@shared/contract/turnTimeline';
import { redactBrowserComputerInputPayloadsInValue } from '@shared/utils/browserComputerRedaction';
import {
  Anchor,
  AlertTriangle,
  AudioLines,
  ChevronRight,
  ChevronDown,
  Check,
  CheckCircle2,
  CircleDot,
  Copy,
  FileText,
  GitFork,
  LoaderCircle,
  ShieldAlert,
  Sparkles,
  Wrench,
  XCircle,
} from 'lucide-react';
import { Button } from '../../primitives';
import { UI } from '@shared/constants';
import { TraceNodeRenderer } from './TraceNodeRenderer';
import { ExpandableContent } from './ExpandableContent';
import { StreamingIndicator, getRunningSubagentCount, getRunningToolStartTime, getStreamingWaitingReason } from './StreamingIndicator';
import { TurnDiffSummary } from './MessageBubble/TurnDiffSummary';
import { buildTurnFileChanges } from '../../../utils/turnDiffSummary';
import { isBareInterruptionNode } from '../../../utils/bareInterruptionNode';
import { envParkedTurnDuration } from '../../../utils/envParkedTurn';
import { useSessionStore } from '../../../stores/sessionStore';
import { getTurnFinalTextNode, getTurnUserNode } from '../../../utils/turnRailItems';
import { TurnFeedback } from './TurnFeedback';
import { MessageContextMenu } from './MessageContextMenu';
import { TurnCompactionMarker } from './TurnCompactionMarker';
import { TurnOutcomeBadge } from './TurnOutcomeBadge';
import { ToolStepGroup } from './ToolStepGroup';
import { integrateToolReceipts } from './receiptStepIntegration';
import {
  ThinkingDigestBanner,
  getHasNonThinkingContentAfterThinking,
  getTurnThinkingSegments,
} from './ThinkingDigestBanner';
import {
  groupAdjacentToolCalls,
  formatTurnDuration,
} from '../../../utils/toolStepGrouping';
import {
  buildStreamingUiState,
  shouldShowStreamingState,
  type RuntimeSessionStatus,
  type StreamingUiState,
} from '../../../utils/streamingStatePresentation';
import { isReadOnlyArtifactOwnershipItem } from '../../../utils/artifactOwnership';
import { useI18n } from '../../../hooks/useI18n';
import { useLocalizeRole } from '../../../hooks/useLocalizeRole';
import { humanizeToolStep } from '../../../utils/humanizeToolStep';
import type { Translations } from '../../../i18n';
import { turnPhaseFallbackLabel } from '../../../utils/turnPhaseFallback';
import { useMessageActionStore } from '../../../stores/messageActionStore';
import { useAppStore } from '../../../stores/appStore';
import { useWorkDetailPolicy } from '../../../utils/workDetailPolicy';
import { useVoiceLiveRuntime } from '../../../hooks/useVoiceLiveRuntime';
import { hasPendingPermissionForSession, hasQueuedPermissionForSession } from '../../../utils/sessionNeedsInput';
import { useSessionTurnActive } from '../../../hooks/useSessionTurnActive';
import { resolveBusySignal } from '../../../utils/turnBusySignal';
import { useTurnCardExpansion } from './useTurnCardExpansion';
import { hasFoldHiddenMiddle, isNodeSkippedInMiddle } from './turnFoldVisibility';
import { getObservedCronRunStatusForSession, hasParkedApprovalClosure, isLiveCronRunStatusKind, subscribeObservedCronRunStatus } from './cronRunSessionStatus';
interface TurnCardProps {
  turn: TraceTurn;
  sessionId?: string;
  defaultExpanded?: boolean;
  /** Force expand for search matches */
  forceExpanded?: boolean;
  expandRequest?: { nodeId: string };
  /** This turn contains the active search match */
  highlightActive?: boolean;
  /** This turn is the current active renderer turn. */
  isActiveTurn?: boolean;
  /** 会话最后一轮：操作行（复制/赞/踩/分叉）只在这轮常驻，历史轮 hover 才显示 */
  isLastTurn?: boolean;
  sessionStatus?: RuntimeSessionStatus | null;
  isSessionProcessing?: boolean;
  streamSnapshot?: StreamRecoverySnapshot | null;
  showSeparator?: boolean;
  onStreamingDisplayUpdate?: (nodeId: string, displayLength: number, isAnimating: boolean) => void;
  onRewindUserPrompt?: (messageId: string, content: string) => void;
  /** 渲染在该 turn 用户消息上方（目前用于分叉子会话首段的来源提示） */
  beforeUserMessage?: React.ReactNode;
  /** 渲染在该 turn 用户消息下方（目前用于定时任务运行记录的状态行） */
  afterUserMessage?: React.ReactNode; suppressBusySignal?: boolean;
}
export const TurnCard: React.FC<TurnCardProps> = ({
  turn,
  sessionId,
  defaultExpanded,
  forceExpanded,
  expandRequest,
  highlightActive,
  isActiveTurn,
  isLastTurn,
  sessionStatus,
  isSessionProcessing,
  streamSnapshot,
  showSeparator = true,
  onStreamingDisplayUpdate,
  onRewindUserPrompt,
  beforeUserMessage, afterUserMessage, suppressBusySignal,
}) => {
  const { t } = useI18n(); const policy = useWorkDetailPolicy();
  const createForkFromReply = useMessageActionStore((state) => state.createForkFromReply);
  const sessionTurnActive = useSessionTurnActive(sessionId);
  const turnActive = Boolean(isSessionProcessing) || sessionTurnActive;
  const waitingForApproval = useAppStore((state) => (
    sessionId
      ? hasPendingPermissionForSession(sessionId, state)
        || hasQueuedPermissionForSession(sessionId, state)
      : false
  ));
  const developerMode = useAppStore((state) => state.developerMode);
  const voiceRuntime = useVoiceLiveRuntime();
  const voiceCallInFlight = voiceRuntime.phase === 'live' || voiceRuntime.phase === 'connecting';
  const [isForking, setIsForking] = useState(false);
  const hasEnvPark = useMemo(() => turn.nodes.some(node => node.metadata?.envAssist?.parkedToolCallId), [turn.nodes]);
  const messages = useSessionStore(state => hasEnvPark && state.currentSessionId === sessionId ? state.messages : undefined);
  const stats = useMemo(() => {
    const duration = envParkedTurnDuration(turn, messages ?? []);
    const time = new Date(turn.startTime).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return { duration, time };
  }, [turn, messages]);
  const isStreaming = turn.status === 'streaming';
  const displayNodes = useMemo(
    () => groupAdjacentToolCalls(turn.nodes),
    [turn.nodes]
  );
  const artifactNode = useMemo(
    () => turn.nodes.find((node) => node.turnTimeline?.kind === 'artifact_ownership'),
    [turn.nodes],
  );
  const receiptIntegration = useMemo(() => integrateToolReceipts(artifactNode, displayNodes), [artifactNode, displayNodes]);
  const { matchedReceiptItems, residualArtifactNode } = receiptIntegration;
  const deliverableDiffPaths = useMemo(() => new Set(
    (artifactNode?.turnTimeline?.artifactOwnership || [])
      .filter((item) => item.role === 'deliverable' && item.kind === 'file')
      .flatMap((item) => (item.path ? [item.path] : [])),
  ), [artifactNode]);
  const deliverableFileChanges = useMemo(() => new Map(
    buildTurnFileChanges(turn)
      .filter((change) => deliverableDiffPaths.has(change.filePath))
      .map((change) => [change.filePath, change]),
  ), [deliverableDiffPaths, turn]);
  const hasStreamInterruption = useMemo(() => turn.nodes.some((node) => (
    !isBareInterruptionNode(node) && Boolean(node.metadata?.streamInterruptionReason || node.metadata?.streamRecovery)
  )), [turn.nodes]);
  const voiceDispatch = useMemo(() => {
    for (const node of turn.nodes) {
      const dispatch = node.metadata?.voiceDispatch;
      if (dispatch) return dispatch;
    }
    return null;
  }, [turn.nodes]);
  const isVoiceTurn = Boolean(voiceDispatch);
  const foldedView = useMemo(() => ({
    userNode: getTurnUserNode(turn),
    finalTextNode: getTurnFinalTextNode(turn, isVoiceTurn),
  }), [turn, isVoiceTurn]);
  const observedCronRunStatus = useSyncExternalStore(subscribeObservedCronRunStatus, () => getObservedCronRunStatusForSession(sessionId), () => null);
  const hasExternalStatusLine = Boolean(afterUserMessage) && !hasParkedApprovalClosure(turn); const hasLiveExternalStatusLine = hasExternalStatusLine && isLiveCronRunStatusKind(observedCronRunStatus?.kind);
  const canFold = isVoiceTurn ? turn.nodes.length > 0
    : hasExternalStatusLine
      ? !hasLiveExternalStatusLine
      : turn.status === 'completed' &&
        !isStreaming &&
        turn.nodes.length >= policy.foldThreshold &&
        Boolean(foldedView.finalTextNode) &&
        hasFoldHiddenMiddle(displayNodes, foldedView.userNode, foldedView.finalTextNode);
  const { expanded, folded, handleToggleExpanded } = useTurnCardExpansion({
    canFold, hasExternalStatusLine, keepLastTurnOpen: policy.keepLastTurnOpen,
    defaultExpanded, isSessionProcessing, forceExpanded, expandRequest,
  });
  const lastIndex = displayNodes.length - 1;
  const lastDisplay = displayNodes[lastIndex];
  const lastDisplayNode = lastDisplay && lastDisplay.kind !== 'tool_group' ? lastDisplay.node : null;
  const busySignal = resolveBusySignal(turn);
  const lastNodeIsStreamingText =
    busySignal === 'text-caret' &&
    !!lastDisplayNode &&
    lastDisplayNode.type === 'assistant_text' &&
    Boolean(lastDisplayNode.content?.trim());
  const runningToolStartTime = useMemo(
    () => getRunningToolStartTime(turn.nodes),
    [turn.nodes],
  );
  const streamingState = useMemo(
    () => buildStreamingUiState({
      turn,
      t,
      isActiveTurn: Boolean(isActiveTurn),
      sessionStatus,
      isSessionProcessing,
      streamSnapshot,
      runningToolStartTime,
    }),
    [isActiveTurn, isSessionProcessing, runningToolStartTime, sessionStatus, streamSnapshot, t, turn],
  );
  const hookActivity = useMemo(() => getTurnHookActivity(turn), [turn]);
  const skillActivity = useMemo(() => getTurnSkillActivity(turn), [turn]);
  const isNeoTagTurn = useMemo(
    () => turn.nodes.some((node) => node.type === 'user' && Boolean(node.metadata?.neoTag)),
    [turn.nodes],
  );
  const thinkingSegments = useMemo(() => getTurnThinkingSegments(turn), [turn]);
  const hasTimelineActivity = turn.nodes.some((node) => node.type !== 'user' && (
    node.type !== 'assistant_text'
    || Boolean(node.content?.trim())
    || Boolean((node.thinking || node.reasoning)?.trim())
  ));
  const preparationPhase = busySignal === 'text-caret' && !lastNodeIsStreamingText
    ? hasTimelineActivity ? 'organizing' : undefined
    : undefined;
  const streamingIndicator = isStreaming && !suppressBusySignal ? (
    <StreamingIndicator
      startTime={turn.startTime}
      runningToolStartTime={!waitingForApproval && busySignal === 'text-caret' ? runningToolStartTime : undefined}
      showCaret={waitingForApproval || busySignal === 'text-caret'}
      preparationPhase={waitingForApproval ? undefined : preparationPhase}
      waitingReason={waitingForApproval ? 'approval' : busySignal === 'text-caret'
        ? !lastNodeIsStreamingText && !hasTimelineActivity ? 'model' : undefined
        : getStreamingWaitingReason(turn.nodes, streamingState.status, waitingForApproval)}
      subagentCount={getRunningSubagentCount(turn.nodes)}
    />
  ) : null;
  const activeThinkingSegmentId = busySignal === 'thinking'
    ? thinkingSegments[thinkingSegments.length - 1]?.id ?? null
    : null;
  const hasNonThinkingContentAfterThinking = useMemo(
    () => getHasNonThinkingContentAfterThinking(turn, thinkingSegments),
    [thinkingSegments, turn],
  );
  const feedbackAnchor = useMemo(() => {
    if (isStreaming) return null;
    const node = turn.nodes.find((item) => item.feedbackEligible === true);
    const content = node?.content?.trim();
    if (!node || !content) return null;
    const messageId = node.messageId
      || (node.id.endsWith('-text') ? node.id.slice(0, -5) : node.id);
    return { messageId, content };
  }, [isStreaming, turn.nodes]);
  const forkAnchor = useMemo(() => {
    if (isStreaming) return null;
    const node = turn.nodes.find((item) => item.feedbackEligible === true);
    if (!node) return null;
    const messageId = node.messageId
      || (node.id.endsWith('-text') ? node.id.slice(0, -5) : node.id);
    return { messageId };
  }, [isStreaming, turn.nodes]);
  const feedbackEligibleNodeId = useMemo(
    () => turn.nodes.find((item) => item.feedbackEligible === true)?.id ?? null,
    [turn.nodes],
  );
  const [anchorTypewriterCaughtUp, setAnchorTypewriterCaughtUp] = useState(true);
  const handleAnchorStreamingDisplayUpdate = useCallback(
    (nodeId: string, displayLength: number, isAnimating: boolean) => {
      onStreamingDisplayUpdate?.(nodeId, displayLength, isAnimating);
      if (nodeId === feedbackEligibleNodeId) {
        setAnchorTypewriterCaughtUp(!isAnimating);
      }
    },
    [onStreamingDisplayUpdate, feedbackEligibleNodeId],
  );
  const hasVoiceFailureEvidence = useMemo(
    () => isVoiceTurn && (
      turn.status === 'error'
      || turn.nodes.some((node) => (
        (node.type === 'system' && node.subtype === 'error' && node.metadata?.source === 'voice')
        || node.turnTimeline?.tone === 'error'
      ))
    ),
    [isVoiceTurn, turn.nodes, turn.status],
  );
  const suppressReplyActions =
    (isVoiceTurn && voiceCallInFlight && !turn.voiceWorkOutcome && !hasVoiceFailureEvidence)
    || (isLastTurn && turnActive);
  const compactionNodes = useMemo(
    () => turn.nodes.filter((n) => n.type === 'system' && n.subtype === 'compaction'),
    [turn.nodes],
  );
  const [compactionExpanded, setCompactionExpanded] = useState(false);
  const showReplyActions =
    Boolean(forkAnchor || feedbackAnchor) && !suppressReplyActions && anchorTypewriterCaughtUp;
  const handleFork = async () => {
    if (!forkAnchor || isForking || turnActive) return;
    setIsForking(true);
    try {
      await createForkFromReply(forkAnchor.messageId, 'shared_current');
    } finally {
      setIsForking(false);
    }
  };
  return (
    <div
      className={`mb-2 transition-colors group/turncard ${
        highlightActive ? 'bg-amber-500/5' : ''
      }`}
    >
      {showSeparator && (
        <div className="flex items-center gap-2 py-1.5">
          <div className="h-px flex-1 bg-zinc-800"></div>
          {/* 只说时间点。轮时长由下面折叠按钮那一处带「用时」标签地讲——
              同一个数字在同一屏出现两次、其中一次还没有标签，正是第 17 条那个歧义。
              UX round2 20i：时间戳每轮常驻可见（低透明度常态、hover 提亮）。
              此前 opacity-0 + group-hover 浮出——滚动时鼠标静止、卡片从光标下穿过，
              :hover 随卡片边界高速翻转，时间戳「开始时间数字会随页面滑动偶尔消失但还在」
              的闪烁就是这条 hover 门控造成的；常驻后闪烁根因消除。 */}
          <span className="text-[10px] text-zinc-500 shrink-0 opacity-60 transition-opacity duration-150 group-hover/turncard:opacity-100">{stats.time}</span>
          <div className="h-px flex-1 bg-zinc-800"></div>
        </div>
      )}
      {/* Content */}
      <div className="space-y-2 px-4">
        {beforeUserMessage}
        {/* User message always at top */}
        {foldedView?.userNode && (
          <TraceNodeRenderer
            node={foldedView.userNode}
            sessionId={sessionId} isStreaming={isStreaming}
            attachments={foldedView.userNode.attachments}
            inVoiceDispatchCard={isVoiceTurn}
            onRewindUserPrompt={onRewindUserPrompt}
            rewindDisabled={Boolean(isSessionProcessing)}
            suppressSendFailedBadge={isProjectTrustPendingTurn(turn)}
          />
        )}
        {afterUserMessage}
        {/* Neo 以参与者身份回复（像 Claude Tag）：轻量身份标识挂在回复头部，会话里不出现工作卡 */}
        {isNeoTagTurn && (
          <div className="flex items-center gap-1.5 pt-0.5" data-testid="neo-turn-identity">
            <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-badge-success/30 bg-emerald-500/15">
              <Sparkles className="h-2.5 w-2.5 text-badge-success" />
            </span>
            <span className="text-[11px] font-medium text-badge-success/90">Neo</span>
          </div>
        )}
        {/* 语音派活任务卡卡头：整轮的头一句话——这件活是什么、谁做的。
            不显示任何状态徽章（X5.5 返工批 R4a 产品拍板）：结局判定是 host 证据门的事，
            卡片不转述。过程折叠在卡身里，结论（最后一条有正文的 assistant_text）走下方既有
            finalTextNode 通道留在卡外——过程中模型会穿插「我来做」类过渡文本，
            只有最后一条正文是这轮给用户看的结论，与 Codex 式外壳的切法同一条判据。 */}
        {isVoiceTurn && voiceDispatch && (
          <VoiceDispatchCardHeader
            title={voiceDispatch.title}
            speaker={voiceDispatch.speaker}
            expanded={expanded}
            onToggle={handleToggleExpanded}
          />
        )}
        <TurnRunHeader turn={turn} streamingState={streamingState} />
        {developerMode && <TurnOutcomeBadge turn={turn} sessionId={sessionId} />}
        {shouldShowStreamingState(streamingState) && (
          <StreamingStateBanner state={streamingState} />
        )}
        {hookActivity && <HookExecutionBanner activity={hookActivity} />}
        {skillActivity && <SkillActivityBanner activity={skillActivity} />}
        {/* "Worked for Xm Ys" toggle — always visible when foldable。
            语音任务卡的展开/收起由上面的卡头承担，不再重复一个折叠钮；
            定时任务运行记录首轮同理（CronRunSessionStatusBar 已显示用时与状态）。 */}
        {canFold && !isVoiceTurn && !hasExternalStatusLine && (
          <button
            onClick={handleToggleExpanded}
            className="flex items-center gap-1.5 text-xs leading-4 text-zinc-500 hover:text-zinc-300 transition-colors py-0.5"
            aria-expanded={expanded}
            title={expanded ? t.turnCard.collapseTurn : t.turnCard.expandTurn}
          >
            {expanded ? (
              <ChevronDown className="w-3 h-3 flex-shrink-0 text-zinc-500" />
            ) : (
              <ChevronRight className="w-3 h-3 flex-shrink-0 text-zinc-500" />
            )}
            <span>
              {t.turnCard.workedFor.replace(
                '{duration}',
                stats.duration !== null ? formatTurnDuration(stats.duration) : '—',
              )}
            </span>
          </button>
        )}
        {/* Middle content (folded: hide; expanded: show all except user) */}
        {!folded && (
          <>
            {/* 一个回合内所有思考段合并成一个横幅。流式 reasoning 是唯一的「正在思考」
                信号，底部指示器让位。简洁档只在回合结束后藏横幅，流式期间必须留下。 */}
            {(policy.showThinkingDigest || isStreaming) && <ThinkingDigestBanner
              segments={thinkingSegments}
              activeSegmentId={activeThinkingSegmentId}
              hasNonThinkingContentAfterThinking={hasNonThinkingContentAfterThinking}
              turnEndTime={turn.endTime}
            />}
            {displayNodes.map((d, i) => {
              if (d.kind === 'tool_group') {
                return (
                  <ToolStepGroup
                    key={d.key}
                    nodes={d.tools}
                    turnNodes={turn.nodes}
                    sessionId={sessionId}
                    defaultExpanded={policy.toolGroupDefaultExpanded}
                    isStreamingTurn={isStreaming}
                    receipts={matchedReceiptItems.filter((item) => (
                      Boolean(item.sourceNodeId)
                      && d.tools.some((node) => node.id === item.sourceNodeId)
                    ))}
                    receiptTimestamp={artifactNode?.turnTimeline?.timestamp}
                  />
                );
              }
              const node: TraceNode = d.node;
              if (isNodeSkippedInMiddle(node, foldedView.userNode, foldedView.finalTextNode, canFold)) {
                return null;
              }
              const isNodeStreaming = isStreaming
                && i === lastIndex
                && node.type === 'assistant_text'
                && lastNodeIsStreamingText;
              const shouldReportDisplayUpdate =
                node.type === 'assistant_text' &&
                (isNodeStreaming || (!isStreaming && node.id === foldedView?.finalTextNode?.id));
              return (
                <TraceNodeRenderer
                  key={node.id}
                  node={node}
                  sessionId={sessionId}
                  attachments={node.attachments}
                  isStreaming={isNodeStreaming} unfinishedToolIsLive={hasLiveExternalStatusLine || undefined}
                  inVoiceDispatchCard={isVoiceTurn}
                  onStreamingDisplayUpdate={shouldReportDisplayUpdate ? handleAnchorStreamingDisplayUpdate : undefined}
                  onRewindUserPrompt={onRewindUserPrompt}
                  rewindDisabled={Boolean(isSessionProcessing)}
                />
              );
            })}
            {/* 忙信号永远跟在最后一个已渲染时间线节点后；空时间线时它自然成为首节点。
                正文流式时这里只留下唯一的文本尾光标。 */}
            {streamingIndicator}
          </>
        )}
        {/* 语音任务卡折叠态仍在流式时：过程收在卡身里，live 信号不能全灭——
            底部保留呼吸态指示。 */}
        {isVoiceTurn && folded && isStreaming && busySignal === 'text-caret' && (
          <StreamingIndicator
            startTime={turn.startTime}
            runningToolStartTime={runningToolStartTime}
            showCaret
            preparationPhase={preparationPhase}
            subagentCount={getRunningSubagentCount(turn.nodes)}
          />
        )}
        {/* Final AI answer (always shown when foldable; non-foldable turns already rendered in map above).
            定时任务运行记录若在工具调用前有过渡句且后续工具尚未完成（等批准/运行中/已中断），
            不把那句过渡话当最终结果展示。 */}
        {canFold && foldedView?.finalTextNode && !(
          hasExternalStatusLine
          && turn.nodes
            .slice(turn.nodes.indexOf(foldedView.finalTextNode) + 1)
            .some((node) => node.type === 'tool_call' && node.toolCall?.result === undefined)
        ) && (
          <TraceNodeRenderer
            node={foldedView.finalTextNode}
            sessionId={sessionId}
            attachments={foldedView.finalTextNode.attachments}
            inVoiceDispatchCard={isVoiceTurn}
            onStreamingDisplayUpdate={handleAnchorStreamingDisplayUpdate}
          />
        )}
        {/* 产物/来源固定锚点：始终渲染在最终答案之后，位置稳定（与正文内 Sources 一致），
            不再随工具调用在流中的位置而在答案上方/下方漂移。 */}
        {(() => {
          return residualArtifactNode ? (
            <TraceNodeRenderer
              key={residualArtifactNode.id}
              node={residualArtifactNode}
              sessionId={sessionId}
              isStreaming={isStreaming}
              fileChangesByPath={deliverableFileChanges}
            />
          ) : null;
        })()}
        {/* 非交付物继续走轮级 diff；deliverable 的 diff 收在产物卡内。 */}
        {!hasStreamInterruption && (
          <TurnDiffSummary turn={turn} excludedFilePaths={deliverableDiffPaths} />
        )}
        {/* 评价对象是这一轮的回答，所以位置在整轮最后——挂在正文节点里会插在答案和
            它产出的文件卡之间，看起来像在给上面那一句话打分。
            操作行（复制/好评/差评/分叉）只在最后一轮常驻；历史轮 hover 进入该轮才显示，
            避免多轮会话里每轮都拖一条操作行造成的割裂感（2026-07-29 产品反馈）。
            anchorTypewriterCaughtUp：等正文打字机追平 content 再挂载，别让按钮抢跑在
            仍在 flush 追帧的正文前面（排查报告 §2 序列③④）。 */}
        {showReplyActions && (
          <div
            className={`flex items-center gap-2 ${isLastTurn ? '' : 'opacity-0 transition-opacity duration-150 group-hover/turncard:opacity-100'}`}
            data-testid="turn-reply-actions"
          >
            {feedbackAnchor && (
              <>
                <TurnCopyAction content={feedbackAnchor.content} />
                <TurnFeedback messageId={feedbackAnchor.messageId} content={feedbackAnchor.content} />
                <MessageContextMenu sessionId={sessionId} messageId={feedbackAnchor.messageId} />
              </>
            )}
            {forkAnchor && (
              <button /* ds-allow:button: 与点赞点踩同形的回复操作小图标按钮，Button primitive 无此紧凑图标变体 */
                type="button"
                data-testid="turn-fork-action"
                aria-label={t.turnCard.createForkFromReply}
                title={t.turnCard.createForkFromReply}
                disabled={turnActive || isForking}
                onClick={() => void handleFork()}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-transparent text-zinc-500 transition-colors hover:border-badge-accent/40 hover:bg-violet-500/10 hover:text-badge-accent focus:outline-hidden focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
              >
                {isForking
                  ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  : <GitFork className="h-3.5 w-3.5" />}
              </button>
            )}
            {compactionNodes.length > 0 && (
              <TurnCompactionMarker
                expanded={compactionExpanded}
                onToggle={() => setCompactionExpanded((v) => !v)}
              />
            )}
          </div>
        )}
        {/* 压缩标记点开后的摘要原文：只在要读的时候占地方 */}
        {compactionExpanded && compactionNodes.map((node) => (
          <div
            key={node.id}
            className="mt-1 px-3 py-2.5 rounded-md bg-amber-500/5 border border-badge-warning/10"
            data-testid="turn-compaction-summary"
          >
            <ExpandableContent content={node.content} maxLines={30} />
          </div>
        ))}
        {/* 操作行不渲染的轮（流式中/语音在飞等），压缩标记降级为独立的右对齐小行，
            不让「压过」这件事在消息流里彻底消失。 */}
        {!showReplyActions && compactionNodes.length > 0 && (
          <div className="flex justify-end">
            <TurnCompactionMarker
              expanded={compactionExpanded}
              onToggle={() => setCompactionExpanded((v) => !v)}
            />
          </div>
        )}
      </div>
    </div>
  );
};
const VoiceDispatchCardHeader: React.FC<{
  title: string;
  speaker?: { agentId: string; displayName: string };
  expanded: boolean;
  onToggle: () => void;
}> = ({ title, speaker, expanded, onToggle }) => {
  const { t } = useI18n();
  const localizeRole = useLocalizeRole();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid="voice-task-card-header"
      aria-expanded={expanded}
      title={expanded ? t.voice.taskCard.collapseProcess : t.voice.taskCard.expandProcess}
      onClick={onToggle}
      className="-mx-3 w-[calc(100%+1.5rem)] [&>span]:flex [&>span]:w-full [&>span]:min-w-0 [&>span]:items-center [&>span]:gap-2"
    >
      <AudioLines className="h-4 w-4 shrink-0 text-zinc-500" />
      <span className="min-w-0 truncate text-left font-medium text-zinc-300">{title}</span>
      {speaker && (
        <span
          data-testid="voice-task-speaker"
          className="shrink-0 rounded-md border border-border-muted bg-surface-subtle px-1.5 py-0.5 text-[11px] text-zinc-400"
        >
          {localizeRole(speaker.displayName, { name: speaker.displayName }).name}
        </span>
      )}
      {expanded ? (
        <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-zinc-600" />
      ) : (
        <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-zinc-600" />
      )}
    </Button>
  );
};
const TurnCopyAction: React.FC<{ content: string }> = ({ content }) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    if (!content.trim()) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), UI.COPY_FEEDBACK_DURATION);
    } catch {
      // clipboard unavailable (permission/insecure context): the copied tick simply stays off
    }
  };
  return (
    <button /* ds-allow:button: 「复制回答」是回复操作行的图标级小按钮，Button primitive 无此紧凑图标变体 */
      type="button"
      data-testid="turn-copy-action"
      aria-label={copied ? t.turnCard.answerCopied : t.turnCard.copyAnswer}
      title={copied ? t.turnCard.answerCopied : t.turnCard.copyAnswer}
      onClick={() => void handleCopy()}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-transparent text-zinc-500 transition-colors hover:border-zinc-700 hover:bg-zinc-800/70 hover:text-zinc-300 focus:outline-hidden focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]"
    >
      {copied
        ? <Check className="h-3.5 w-3.5 text-badge-success" />
        : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
};
const HOOK_EVENT_LABELS: Record<string, string> = {
  UserPromptSubmit: '用户提示提交',
  SessionStart: '会话开始',
  SessionEnd: '会话结束',
  PreToolUse: '工具前',
  PostToolUse: '工具后',
  PostToolUseFailure: '工具失败',
  PermissionRequest: '权限请求',
  PermissionDenied: '权限拒绝',
  PreCompact: '压缩前',
  PostCompact: '压缩后',
  Stop: '停止',
  StopFailure: '停止失败',
  SubagentStart: '子代理开始',
  SubagentStop: '子代理停止',
  PostExecution: '执行后',
  Setup: '初始化',
  Notification: '通知',
  TaskCreated: '任务创建',
  TaskCompleted: '任务完成',
  RoleWake: '角色唤醒',
  VoiceCallStarted: '通话开始',
  VoiceCallPaused: '通话暂停',
  VoiceCallEnded: '通话结束',
};
function getTurnHookActivity(turn: TraceTurn): TurnHookActivity | null {
  const node = turn.nodes.find((candidate) => (
    candidate.turnTimeline?.kind === 'hook_activity'
    && candidate.turnTimeline.hookActivity
  ));
  return node?.turnTimeline?.hookActivity ?? null;
}
function getTurnSkillActivity(turn: TraceTurn): TurnSkillActivity | null {
  const node = turn.nodes.find((candidate) => (
    candidate.turnTimeline?.kind === 'skill_activity'
    && candidate.turnTimeline.skillActivity
  ));
  return node?.turnTimeline?.skillActivity ?? null;
}
function getHookActivityTone(activity: TurnHookActivity): 'success' | 'warning' | 'error' {
  if (activity.items.some((item) => (item.errorCount || 0) > 0)) return 'error';
  if (activity.items.some((item) => item.action === 'block' || item.modified)) return 'warning';
  return 'success';
}
function getHookStatusText(activity: TurnHookActivity, t: Translations): string {
  const blockedItems = activity.items.filter((item) => item.action === 'block');
  if (blockedItems.length > 0) {
    const base = t.turnHooks.blockedCount.replace('{count}', String(blockedItems.length));
    const reason = blockedItems.length === 1 ? blockedItems[0]?.reason : undefined;
    return reason ? `${base} · ${t.turnHooks.reason.replace('{reason}', reason)}` : base;
  }
  const errors = activity.items.reduce((sum, item) => sum + (item.errorCount || 0), 0);
  if (errors > 0) return t.turnHooks.errored.replace('{count}', String(errors));
  const modified = activity.items.filter((item) => item.modified).length;
  if (modified > 0) return t.turnHooks.modifiedCount.replace('{count}', String(modified));
  return t.turnHooks.allowed;
}
const HookExecutionBanner: React.FC<{ activity: TurnHookActivity }> = ({ activity }) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const tone = getHookActivityTone(activity);
  const statusText = getHookStatusText(activity, t);
  const showStatus = tone !== 'success' && activity.items.length > 0;
  return (
    <div className="py-0.5 text-sm text-zinc-500">
      {activity.items.length > 0 && (
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 rounded-md py-0.5 text-left text-zinc-500 transition-colors hover:text-zinc-300"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          title={showStatus ? statusText : undefined}
        >
          <Anchor className="h-4 w-4 shrink-0" />
          <span className="shrink-0 font-medium">{t.turnHooks.title}</span>
          {/* 折叠态就说清「哪个时机、是哪几个 hook」——不展开也知道刚才动了什么 */}
          <span className="min-w-0 truncate text-zinc-600">{activity.summary}</span>
          {showStatus && (
            <span className={`max-w-[360px] shrink-0 truncate rounded px-1 py-px text-[11px] ${getHookIssueClass(tone)}`}>
              {statusText}
            </span>
          )}
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
          )}
        </button>
      )}
      {/* 慢 hook 的 running 指示：>300ms 才淡入（CSS delay，无 JS 定时器），
          批次完成（hook_trigger 落账）后随 projection 移除，落为上面的常驻 banner。 */}
      {activity.running && (
        <div className="hook-running-enter flex items-center gap-2 py-0.5" data-testid="hook-running-indicator">
          <Anchor className="h-4 w-4 shrink-0 animate-pulse" />
          <span className="streaming-thinking-shimmer font-medium">
            {t.turnHooks.title} · {t.turnHooks.running.replace('{event}', HOOK_EVENT_LABELS[activity.running.event] || activity.running.event)}
          </span>
        </div>
      )}
      {expanded && activity.items.length > 0 && (
        <div className="ml-7 mt-1 space-y-1 text-[13px] leading-5 text-zinc-500">
          {activity.items.map((item, index) => {
            const label = HOOK_EVENT_LABELS[item.event] || item.event;
            const injectedContentLabel = (item.names || []).join('、') || item.toolName || item.matcher || undefined;
            const title = injectedContentLabel;
            const itemStatus = getHookItemStatusText(item, t);
            return (
              <div
                key={`${item.event}-${item.timestamp}-${index}`}
                className="min-w-0"
                title={title || undefined}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0">{label}</span>
                  {injectedContentLabel && (
                    <span className="min-w-0 truncate text-zinc-600">{injectedContentLabel}</span>
                  )}
                  {itemStatus && (
                    <span className={`shrink-0 rounded px-1 py-px text-[11px] ${getHookIssueClass(itemStatus.tone)}`}>
                      {itemStatus.label}
                    </span>
                  )}
                </div>
                {/* 决策原因（block/modify 的首行摘要，host 侧已截断+脱敏）是唯一上屏的
                    hook 文本；Stop hook 拦下收尾时这行就是「为什么还要求继续」。 */}
                {item.reason && (item.action === 'block' || item.modified) && (
                  <div className="mt-0.5 truncate text-badge-warning/70" title={item.reason}>
                    {t.turnHooks.reason.replace('{reason}', item.reason)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
function getHookItemStatusText(
  item: TurnHookActivity['items'][number],
  t: Translations,
): { label: string; tone: 'warning' | 'error' } | null {
  // 拦下/改写是 hook 的正常决策（amber）；Stop 系拦下是「要求 agent 继续」，措辞区分开
  if (item.action === 'block') {
    const isStopGate = item.event === 'Stop' || item.event === 'StopFailure';
    return { label: isStopGate ? t.turnHooks.stopBlocked : t.turnHooks.blocked, tone: 'warning' };
  }
  // 只有 hook 自身执行出错才用红
  if ((item.errorCount || 0) > 0) return { label: t.turnHooks.errored.replace('{count}', String(item.errorCount)), tone: 'error' };
  if (item.modified) return { label: t.turnHooks.modified, tone: 'warning' };
  return null;
}

function getLastToolNode(turn: TraceTurn): TraceNode | null {
  for (let index = turn.nodes.length - 1; index >= 0; index--) {
    const node = turn.nodes[index];
    if (node.type === 'tool_call' && node.toolCall) return node;
  }
  return null;
}

// status key（稳定枚举字符串，供 shouldHideTurnRunHeader/测试等逻辑判断用）
// 与 label（走 i18n 的人话显示文案）分开——逻辑别读人话文案。
function getTurnRunStatus(turn: TraceTurn, t: Translations, streamingState?: StreamingUiState): {
  key: string;
  label: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'error';
  icon: React.ReactNode;
} {
  if (streamingState) {
    switch (streamingState.status) {
      case 'cancelling':
        return { key: 'cancelling', label: streamingState.label, tone: 'warning', icon: <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> };
      case 'stale':
        return { key: 'stale_stream', label: streamingState.label, tone: 'neutral', icon: <CircleDot className="h-3.5 w-3.5" /> };
      case 'waiting_tool':
        return { key: 'waiting_tool', label: streamingState.label, tone: 'neutral', icon: <Wrench className="h-3.5 w-3.5" /> };
      case 'using_tools':
        return { key: 'using_tools', label: streamingState.label, tone: 'neutral', icon: <Wrench className="h-3.5 w-3.5" /> };
      case 'drafting':
        return { key: 'running', label: streamingState.label, tone: 'info', icon: <CircleDot className="h-3.5 w-3.5" /> };
      case 'blocked':
        return { key: 'blocked', label: streamingState.label, tone: 'error', icon: <ShieldAlert className="h-3.5 w-3.5" /> };
      default:
        break;
    }
  }

  const timelines = turn.nodes
    .map((node) => node.turnTimeline)
    .filter(Boolean);
  const hasError = turn.status === 'error' || timelines.some((timeline) => timeline?.tone === 'error');
  if (hasError) {
    return { key: 'blocked', label: t.turnRun.status.blocked, tone: 'error', icon: <ShieldAlert className="h-3.5 w-3.5" /> };
  }

  const lastTool = getLastToolNode(turn)?.toolCall;
  if (turn.status === 'streaming') {
    if (lastTool && (lastTool._streaming || lastTool.result === undefined)) {
      return { key: 'using_tools', label: t.turnRun.status.usingTools, tone: 'neutral', icon: <Wrench className="h-3.5 w-3.5" /> };
    }
    return { key: 'running', label: t.turnRun.status.running, tone: 'info', icon: <CircleDot className="h-3.5 w-3.5" /> };
  }

  return { key: 'completed', label: t.turnRun.status.completed, tone: 'success', icon: <CheckCircle2 className="h-3.5 w-3.5" /> };
}

function getTurnPhase(turn: TraceTurn, t: Translations): string | null {

  // 这里曾经用路由摘要当轮次阶段（「已指定 岚析 执行」），既是内部审计口径，又跟
  // 旁边的 Auto 徽章自相矛盾。阶段该说这一轮在做什么，落到下面的能力/工具描述。

  const scope = turn.nodes.find((node) => node.turnTimeline?.kind === 'capability_scope')?.turnTimeline?.capabilityScope;
  if (scope) {
    if (scope.blocked.length > 0) return `${scope.blocked.length} 个能力未生效`;
    if (scope.invoked.length > 0) return `${scope.invoked.length} 个能力已调用`;
  }

  const lastTool = getLastToolNode(turn)?.toolCall;
  if (lastTool) return humanizeToolStep(lastTool.name, lastTool.args, t, lastTool.shortDescription, lastTool.result === undefined || lastTool._streaming ? 'running' : 'completed');

  if (turn.status === 'streaming') return null;

  // 兜底（含「发送失败的轮不标已生成」的判定）在 turnPhaseFallback 助手模块里。
  return turnPhaseFallbackLabel(turn, t);
}

function getTurnCompletionSignal(turn: TraceTurn, t: Translations): string | null {
  const artifacts = turn.nodes.find((node) => node.turnTimeline?.kind === 'artifact_ownership')?.turnTimeline?.artifactOwnership;
  const deliverableArtifacts = artifacts?.filter((item) => !isReadOnlyArtifactOwnershipItem(item)) ?? [];
  if (deliverableArtifacts.length && turn.status !== 'completed') {
    return t.turnRun.outputsSignal.replace('{count}', String(deliverableArtifacts.length));
  }
  const toolCount = turn.nodes.filter((node) => node.type === 'tool_call').length;
  if (toolCount > 0 && turn.status !== 'completed') {
    return t.turnRun.toolsSignal.replace('{count}', String(toolCount));
  }
  return null;
}

function getToneClass(tone: 'neutral' | 'info' | 'success' | 'warning' | 'error'): string {
  switch (tone) {
    case 'success':
      return 'border-badge-success/20 bg-emerald-500/10 text-status-success';
    case 'warning':
      return 'border-badge-warning/20 bg-amber-500/10 text-status-warning';
    case 'error':
      return 'border-red-500/20 bg-red-500/10 text-status-error';
    case 'info':
      return 'border-badge-info/20 bg-sky-500/10 text-badge-info';
    default:
      return 'border-border-muted bg-surface-subtle text-zinc-400';
  }
}

function getHookIssueClass(tone: 'success' | 'warning' | 'error'): string {
  switch (tone) {
    case 'error':
      return 'bg-red-500/10 text-badge-danger';
    case 'warning':
      return 'bg-amber-500/10 text-badge-warning';
    default:
      return 'bg-zinc-800 text-zinc-400';
  }
}

function getStreamingBannerIcon(state: StreamingUiState): React.ReactNode {
  switch (state.status) {
    case 'cancelling':
      return <LoaderCircle className="h-3.5 w-3.5 animate-spin" />;
    case 'blocked':
      return <ShieldAlert className="h-3.5 w-3.5" />;
    case 'waiting_tool':
    case 'using_tools':
      return <Wrench className="h-3.5 w-3.5" />;
    case 'stale':
      return <AlertTriangle className="h-3.5 w-3.5" />;
    default:
      return state.shouldAnimate
        ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        : <CircleDot className="h-3.5 w-3.5" />;
  }
}

const StreamingStateBanner: React.FC<{ state: StreamingUiState }> = ({ state }) => {
  const { t } = useI18n();
  return (
    <div data-testid="streaming-state-banner" className={`flex min-h-9 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${getToneClass(state.tone)}`}>
      <div className="shrink-0">{getStreamingBannerIcon(state)}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{state.label}</div>
        {state.detail && (
          <div className="truncate text-[11px] opacity-80">{state.detail}</div>
        )}
      </div>
      {state.showCancelCleanup && (
        <span className="shrink-0 text-[10px] opacity-60">{t.turnRun.cleanupBadge}</span>
      )}
    </div>
  );
};

// 顶部 run 横幅可见性：完成态 + 正常流式进度（running / using_tools / waiting_tool）
// 统一隐藏。这些状态在流式期间随工具边界来回切换，会让蓝色 running 横幅 mount/unmount
// 「跳上跳下」。正常 live 进度由底部 StreamingIndicator + 工具组内联指示承担；顶部横幅
// 只在异常/终态（blocked/stale）显示稳定状态；resumable 已收进灰字步骤和 DecisionSlot。
// 吃 status key（稳定枚举），不吃 label（人话显示文案）——语言切换不能影响这条逻辑判断。
export function shouldHideTurnRunHeader(statusKey: string, statusTone: string): boolean {
  return statusTone === 'success'
    || statusKey === 'running'
    || statusKey === 'using_tools'
    || statusKey === 'waiting_tool'
    || statusKey === 'resumable';
}

const TurnRunHeader: React.FC<{ turn: TraceTurn; streamingState?: StreamingUiState }> = ({ turn, streamingState }) => {
  const { t } = useI18n();
  const status = getTurnRunStatus(turn, t, streamingState);
  const phase = getTurnPhase(turn, t);
  const completionSignal = getTurnCompletionSignal(turn, t);
  const failedTool = turn.nodes.find((node) => node.type === 'tool_call' && node.toolCall?.success === false)?.toolCall;
  const hasPhase = Boolean(phase?.trim());

  if (shouldHideTurnRunHeader(status.key, status.tone) || isSendFailureTurn(turn)) {
    return null;
  }

  return (
    <div data-testid="turn-run-header" className="flex min-h-7 items-center gap-2 rounded-md border border-border-faint bg-surface-faint px-2 py-1 text-[11px]">
      <div className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 ${getToneClass(status.tone)}`}>
        {status.icon}
        <span className="font-medium">{status.label}</span>
      </div>
      {hasPhase && (
        <div className="min-w-0 flex-1 truncate text-zinc-400">
          {phase}
        </div>
      )}
      {!hasPhase && <div className="flex-1" />}
      {completionSignal && (
        <div className="inline-flex items-center gap-1 rounded-md bg-surface-subtle px-1.5 py-0.5 text-[11px] text-zinc-500">
          <FileText className="h-3 w-3" />
          <span>{completionSignal}</span>
        </div>
      )}
      {failedTool && (
        <div className="inline-flex items-center gap-1 rounded-md bg-red-500/10 px-1.5 py-0.5 text-[11px] text-badge-danger" title={formatFailedToolTitle(failedTool)}>
          <XCircle className="h-3 w-3" />
          <span className="max-w-[120px] truncate">{failedTool.name}</span>
        </div>
      )}
    </div>
  );
};
function formatFailedToolTitle(failedTool: NonNullable<TraceNode['toolCall']>): string | undefined {
  if (typeof failedTool.result !== 'string' || !failedTool.result) {
    return undefined;
  }
  const redacted = redactBrowserComputerInputPayloadsInValue(
    failedTool.name,
    (failedTool.args ?? {}) as Record<string, unknown>,
    failedTool.result,
  );
  return typeof redacted === 'string' ? redacted : failedTool.result;
}
