import type {
  ModelMessage as AiModelMessage,
  SystemModelMessage as AiSystemModelMessage,
} from 'ai';
import { containsThinkTag } from '../../../shared/modelMarkupStrip';

const DESCRIBE_THINK_TAGS = [
  'When discussing model reasoning delimiters, call them the opening thinking tag and closing thinking tag (开放思考标签 and 闭合思考标签).',
  'Use these names in both reasoning and visible prose. Never spell the protocol markup in reasoning or prose.',
  'Answer explanatory questions directly in the user\'s language.',
  'Keep literal bytes in files and tool arguments when the task requires them.',
].join(' ');

export interface AiSdkPromptShape {
  // v7 把顶层 `system` 改名为 `instructions`（`system` 仍在但已 deprecated）。
  // 数组形态受支持 ⇒ 挂在 system 消息上的 providerOptions.anthropic.cacheControl
  // 原样保留，不退化成拼接字符串。
  instructions?: AiSystemModelMessage[];
  messages: AiModelMessage[];
}

export function buildAiSdkPrompt(aiMessages: AiModelMessage[], describeThinkTags = false): AiSdkPromptShape {
  const system: AiSystemModelMessage[] = [];
  const nonSystem: AiModelMessage[] = [];

  for (const message of aiMessages) {
    if (message.role === 'system') {
      system.push(message as AiSystemModelMessage);
    } else {
      nonSystem.push(message);
    }
  }

  if (describeThinkTags && nonSystem.some((message) => {
    if (message.role !== 'user') return false;
    return typeof message.content === 'string'
      ? containsThinkTag(message.content)
      : message.content.some((part) => part.type === 'text' && containsThinkTag(part.text));
  })) {
    system.push({ role: 'system', content: DESCRIBE_THINK_TAGS });
  }

  return {
    ...(system.length > 0 ? { instructions: system } : {}),
    messages: nonSystem,
  };
}
