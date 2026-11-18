// 发送后、首个回复包到达前的助手侧占位：把状态机阶段映射成指示器文案。
// submitting/queued 保留各自文案（含慢启动提示）；waiting_model = 发送已被确认受理，
// 显示「正在准备…」，不再用另一块无 testid 的「等待模型回响」。
import type { AssistantFeedbackState } from '../../../utils/sendWithImmediateAssistantFeedback';
import { StreamingIndicator } from './StreamingIndicator';

const PREPARATION_PHASE = {
  submitting: 'submitting',
  queued: 'queued',
  waiting_model: 'preparing',
} as const;

export function AssistantFeedbackIndicator({ feedback }: { feedback: AssistantFeedbackState }) {
  return (
    <StreamingIndicator
      startTime={feedback.startedAt}
      preparationPhase={PREPARATION_PHASE[feedback.phase]}
    />
  );
}
