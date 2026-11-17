import type { DurableResumeState } from '@shared/contract/session';
import type { EnvAssistNotice } from '@shared/contract/envAssist';
import { useEnvAssistStore } from '../stores/envAssistStore';
import { useSessionStore } from '../stores/sessionStore';
import { useI18n } from './useI18n';
import { useShallow } from 'zustand/react/shallow';

type EnvBlock = NonNullable<DurableResumeState['envBlocked']>;

/** 授权目标的人话名（日历/邮件…）；未登记的目标回落原 id，不吞掉。 */
export function useEnvTargetLabel(block: Pick<EnvBlock, 'target'> | undefined): string | undefined {
  const { t } = useI18n();
  if (!block) return undefined;
  return (t.env.target as Record<string, string>)[block.target] ?? block.target;
}

/**
 * 本会话停在等环境授权上的那一步（env_blocked 停车，envBlocked.toolCallId）与人话授权目标。
 * 只有这一步的工具行改说「等你允许…」，其余行不受影响。
 */
export function useEnvParkedStep(sessionId: string | null | undefined): { toolCallId: string; target: string } | undefined {
  const block = useSessionStore(useShallow((state) => {
    const session = sessionId ? state.sessions?.find((candidate) => candidate.id === sessionId) : undefined;
    const resume = session?.durableResume;
    if (resume?.interruptCause === 'env_blocked') return resume.envBlocked;
    // History can arrive before the session's durable projection. Only a host-marked park qualifies;
    // An already loaded session's durable state outranks a leftover permission card.
    if (session || state.currentSessionId !== sessionId) return undefined;
    const message = state.messages?.findLast(candidate => candidate.metadata?.envAssist?.parkedToolCallId);
    const notice = message?.metadata?.envAssist;
    if (!message || !notice?.parkedToolCallId || !notice.target || notice.phase !== 'needs_user') return undefined;
    if (state.messages.some(candidate => candidate.timestamp > message.timestamp && !candidate.metadata?.envAssist
      && (candidate.role === 'user' || candidate.role === 'assistant'
        || candidate.toolResults?.some(result => result.toolCallId === notice.parkedToolCallId)))) return undefined;
    return { class: notice.class, target: notice.target.id, toolCallId: notice.parkedToolCallId };
  }));
  const target = useEnvTargetLabel(block);
  return block && target ? { toolCallId: block.toolCallId, target } : undefined;
}

export function useEnvParkedTarget(sessionId: string | null | undefined, toolCallId: string): string | undefined {
  const step = useEnvParkedStep(sessionId);
  return step?.toolCallId === toolCallId ? step.target : undefined;
}

/**
 * 停车的那一轮还挂着一张没收起的授权卡吗：有卡时卡已经把「要允许什么、允许后自动接着做」说全，
 * 输入框上方的停住行不再重复（N-FIX-STEP-HEADER-AND-STOPPED-ROW-REPEAT）。卡已「已允许」或这一轮
 * 根本没有卡（系统设置里自己改授权、卡在别的会话）时返回 false，停住行照常说明在等什么。
 */
export function useEnvParkedCardOpen(resume: Pick<DurableResumeState, 'interruptCause' | 'runId'> | undefined): boolean {
  const runId = resume?.interruptCause === 'env_blocked' ? resume.runId : undefined;
  const snapshot = useSessionStore((state) => (runId
    ? state.messages?.find((message) => message.metadata?.envAssist?.runId === runId)?.metadata?.envAssist
    : undefined));
  const live = useEnvAssistStore((state) => (runId
    ? Object.values(state.notices).find((notice) => notice.runId === runId)
    : undefined));
  const notice: EnvAssistNotice | undefined = live && (!snapshot || live.updatedAt >= snapshot.updatedAt) ? live : snapshot;
  return Boolean(notice && notice.phase !== 'resolved');
}

/** 这张授权卡属于本会话正在停车等授权的那个 run：授权后会自动接着做，卡上要说出来。 */
export function useEnvCardResumesAutomatically(notice: Pick<EnvAssistNotice, 'sessionId' | 'runId'>): boolean {
  return useSessionStore((state) => {
    const resume = state.sessions?.find((session) => session.id === notice.sessionId)?.durableResume;
    return resume?.interruptCause === 'env_blocked' && resume.runId === notice.runId;
  });
}
