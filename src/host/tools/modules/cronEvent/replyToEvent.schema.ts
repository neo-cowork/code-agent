// ============================================================================
// reply_to_event schema (N-TRIGGER-OBSERVE-ACTION-CONTRACT-DESIGN)
// ----------------------------------------------------------------------------
// 通道事件自动化运行专用的 host-owned 回复工具：参数只有回复正文（可选 event_id），
// 收件账号/会话由宿主按本批入站事件绑定（eventReplySession），模型给不了也改不了。
// 不进 CORE_TOOLS / DEFERRED_TOOLS_META：普通会话与 ToolSearch 目录都看不到它，
// 只有绑定了事件目的地的事件 run 在组装工具表时注入（withEventReplyTools）。
// ============================================================================
import type { ToolSchema } from '../../../protocol/tools';

export const replyToEventSchema: ToolSchema = {
  name: 'reply_to_event',
  description: `Reply to the inbound chat message that triggered this automation run.

Parameters:
- text (required): the reply message to send.
- event_id (optional): the id= value of the event you are answering, when this run carried more than one event or more than one chat.

The destination (account and chat) is chosen by the host from the inbound event; do not look for other sending tools (messaging MCP tools, browser sends, connector CLIs) and do not pass any account/chat ids. In observe mode the reply is recorded for review instead of sent; otherwise it sends after user approval.`,
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Reply message body to send to the originating chat.',
      },
      event_id: {
        type: 'string',
        description: 'Optional id= value of the event to answer, as shown in the event block.',
      },
    },
    required: ['text'],
  },
  category: 'mcp',
  permissionLevel: 'write',
  emission: {
    kind: 'external_effect',
    targetParameters: ['text'],
    compensationAction: 'send_correction_message_when_supported',
  },
  readOnly: false,
  touchesWorkDirectory: false,
  allowInPlanMode: false,
};
