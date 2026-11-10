// ============================================================================
// Prompt Suggestions Service - 智能提示建议
// ============================================================================

import { createLogger } from '../infra/logger';

const logger = createLogger('PromptSuggestions');

const CONTEXT_MESSAGE_LIMIT = 10;
const USER_MESSAGE_MAX_CHARS = 600;
const ASSISTANT_MESSAGE_MAX_CHARS = 300;

// 禁止词 + 紧跟的「用/使用/运行…」动词 + 被禁的 ASCII 名称（可用 / 、, 和 或 and or 连接）
// 如 "不要用 Bash/curl" → bash, curl；"don't use curl or wget" → curl, wget。
// 只认这种明确的「别用某工具」结构，"don't put it in the README"、"No, use Python"、「识别 Excel」不触发。
const BAN_NAME = '[A-Za-z][A-Za-z0-9_.-]{2,}';
const BAN_TERM_PATTERN = new RegExp(
  '(?:(?:不要|不用|禁止|不许|不能|不准|别)(?:再用|再|使用|调用|执行|运行|用|跑|去)|' +
    "\\b(?:don['’]t|do not|never|must not)\\s+(?:use|using|run|call|rely on)\\b)\\s*" +
    `(${BAN_NAME}(?:\\s*(?:[/、,，&]|和|或|and|or)\\s*${BAN_NAME})*)`,
  'gi',
);
const NON_TOOL_WORDS = new Set(['the', 'any', 'this', 'that', 'for', 'with', 'and', 'you', 'tool', 'tools', 'command', 'commands', 'line', 'anything', 'them', 'those']);

function extractBannedTerms(messages: Array<{ role: string; content?: string }>): string[] {
  const terms = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'user' || !m.content) continue;
    for (const match of m.content.matchAll(BAN_TERM_PATTERN)) {
      for (const word of match[1].match(new RegExp(BAN_NAME, 'g')) ?? []) {
        const lower = word.toLowerCase().replace(/[.-]+$/, '');
        if (lower.length >= 3 && !NON_TOOL_WORDS.has(lower) && !['and', 'or'].includes(lower)) terms.add(lower);
      }
    }
  }
  return [...terms];
}

function mentionsTerm(text: string, term: string): boolean {
  return text.toLowerCase().split(/[^a-z0-9_.-]+/).some(w => w.replace(/^[.-]+|[.-]+$/g, '') === term);
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
    const windowed = messages
      .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
      .slice(-CONTEXT_MESSAGE_LIMIT);
    const recentMessages = windowed
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
- 面向不懂技术的普通人，用日常用语；不要出现命令行、终端、端口、进程、shell、ping、工具、后台任务、代理等技术字眼，除非用户自己用过这些词；多用「把内容发给我」「换个办法」这类大白话

对话：
${recentMessages}

后续建议：`;

    const result = await quickTask(prompt);
    if (!result.success || !result.content) return [];

    const lines = result.content
      .split('\n')
      .map(l => l.replace(/^[-•\d.]\s*/, '').trim())
      .filter(l => l.length > 2 && l.length < 50);

    const banned = extractBannedTerms(windowed);
    const allowed = banned.length
      ? lines.filter(l => !banned.some(t => mentionsTerm(l, t)))
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
