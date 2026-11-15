import type { DurableResumeState } from '@shared/contract/session';
import { useSessionStore } from '../stores/sessionStore';
import { useI18n } from './useI18n';

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
  const block = useSessionStore((state) => {
    const resume = sessionId ? state.sessions.find((session) => session.id === sessionId)?.durableResume : undefined;
    return resume?.interruptCause === 'env_blocked' ? resume.envBlocked : undefined;
  });
  const target = useEnvTargetLabel(block);
  return block && target ? { toolCallId: block.toolCallId, target } : undefined;
}

export function useEnvParkedTarget(sessionId: string | null | undefined, toolCallId: string): string | undefined {
  const step = useEnvParkedStep(sessionId);
  return step?.toolCallId === toolCallId ? step.target : undefined;
}
