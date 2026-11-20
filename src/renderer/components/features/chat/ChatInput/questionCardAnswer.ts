// 提问卡片打开时，composer 里的文字是卡片的答案，而不是排队消息。
// 单问题 + 纯文本 → 当作该卡片的回答；多问题 / 带附件或引用 → 提示后拦下，永不入队。
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import { IPC_CHANNELS } from '@shared/ipc';
import { toast } from '../../../../hooks/useToast';
import ipcService from '../../../../services/ipcService';
import { useSessionStore } from '../../../../stores/sessionStore';

/**
 * 返回 undefined = 没有待答卡片，调用方继续走原有路径（同步返回，不多引入一个 await 微任务）；
 * 否则是该次提交最终结果的 Promise。
 */
export function routeEnvelopeToQuestionCard(
  sessionId: string | null,
  envelope: ConversationEnvelope,
  hint: string,
): Promise<boolean> | undefined {
  if (!sessionId) return undefined;
  const request = useSessionStore.getState().pendingUserQuestionsBySessionId.get(sessionId)?.[0];
  if (!request) return undefined;

  const text = envelope.content.trim();
  const plainText =
    text.length > 0 &&
    !(envelope.attachments?.length) &&
    !(envelope.context?.sessionReferences?.length) &&
    !(envelope.context?.artifactReferences?.length);
  const [question] = request.questions;
  if (!plainText || request.questions.length !== 1 || !question) {
    toast.warning(hint);
    return Promise.resolve(false);
  }

  return ipcService
    .invoke(IPC_CHANNELS.USER_QUESTION_RESPONSE, {
      requestId: request.id,
      answers: { [question.header]: question.multiSelect ? [text] : text },
    })
    .then(() => {
      useSessionStore.getState().clearPendingUserQuestion({ id: request.id, sessionId });
      return true;
    })
    .catch(() => false);
}
