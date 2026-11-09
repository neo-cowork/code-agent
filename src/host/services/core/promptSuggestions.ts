// ============================================================================
// Prompt Suggestions Service - 智能提示建议
// ============================================================================

import { createLogger } from '../infra/logger';

const logger = createLogger('PromptSuggestions');

const CONTEXT_MESSAGE_LIMIT = 10;
const USER_MESSAGE_MAX_CHARS = 600;
const ASSISTANT_MESSAGE_MAX_CHARS = 300;

// 禁止语境词 + 其后约 15 字符内的 ASCII 词（如 "不要用 Bash/curl" → bash, curl）
const BAN_TERM_PATTERN =
  /(?:不要|别|不用|禁止|不许|不能|不准|don't|do not|never|\bno\b)[^\n]{0,15}/gi;

function extractBannedTerms(messages: Array<{ role: string; content?: string }>): string[] {
  const terms = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'user' || !m.content) continue;
    for (const match of m.content.matchAll(BAN_TERM_PATTERN)) {
      for (const word of match[0].match(/[A-Za-z][A-Za-z0-9_.-]{1,}/g) ?? []) {
        const lower = word.toLowerCase();
        if (!['do', 'not', 'dont', 'don', 'never', 'no', 'use', 'the', 'to', 'for', 'this', 'that', 'it', 'any', 'and', 'or', 'my'].includes(lower)) {
          terms.add(lower);
        }
      }
    }
  }
  return [...terms];
}

export interface PromptSuggestion {
  id: string;
  text: string;
  source: 'context' | 'git' | 'history' | 'files';
  category?: 'plan_step' | 'desktop_task' | 'workspace_signal';
  timestampMs?: number;
  priority?: 'high' | 'medium' | 'low';
}

/**
 * Generate context-aware follow-up suggestions using LLM
 * Called after each assistant turn completes
 */
export async function generateContextSuggestions(
  messages: Array<{ role: string; content?: string }>,
): Promise<PromptSuggestion[]> {
  try {
    // Extract recent conversation context
    const recentMessages = messages
      .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
      .slice(-CONTEXT_MESSAGE_LIMIT)
      .map(m => {
        const limit = m.role === 'user' ? USER_MESSAGE_MAX_CHARS : ASSISTANT_MESSAGE_MAX_CHARS;
        return `${m.role === 'user' ? '用户' : '助手'}: ${(m.content || '').slice(0, limit)}`;
      })
      .join('\n');

    if (!recentMessages) return [];

    const { quickTask } = await import('../../model/quickModel');

    const prompt = `根据以下对话，生成 2-3 个用户可能的后续提问或指令。要求：
- 每行一个建议，不要编号
- 简短（15 字以内），以动词开头
- 基于对话上下文，是合理的下一步操作
- 不要重复已经完成的事情
- 尊重用户在对话中提出的任何拒绝、禁止、限制或偏好，后说的优先；绝不建议被拒绝的操作，也不建议它的同义做法
- 面向不懂技术的普通人，用日常用语；不要出现命令行、终端、端口、进程、shell 等字眼，除非用户自己用过这些词

对话：
${recentMessages}

后续建议：`;

    const result = await quickTask(prompt);
    if (!result.success || !result.content) return [];

    const lines = result.content
      .split('\n')
      .map(l => l.replace(/^[-•\d.]\s*/, '').trim())
      .filter(l => l.length > 2 && l.length < 50);

    const banned = extractBannedTerms(messages);
    const allowed = banned.length
      ? lines.filter(l => !banned.some(t => l.toLowerCase().includes(t)))
      : lines;
    if (allowed.length < lines.length) {
      logger.debug('Dropped suggestions containing user-banned terms', { dropped: lines.length - allowed.length });
    }

    return allowed.slice(0, 3).map((text, i) => ({
      id: `ctx-${i}`,
      text,
      source: 'context' as const,
    }));
  } catch (error) {
    logger.debug('Failed to generate context suggestions', { error });
    return [];
  }
}
