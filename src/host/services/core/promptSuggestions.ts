// ============================================================================
// Prompt Suggestions Service - 智能提示建议
// ============================================================================

import { createLogger } from '../infra/logger';
import { stripTelemetryRecoveryNotice } from '../../../shared/telemetryRecovery';
import { LANGUAGE_NAME, type SessionTitleLanguage } from '../../../shared/sessionTitlePrompt';
import { readUiLanguage } from '../../session/sessionTitleHostPrompt';

const logger = createLogger('PromptSuggestions');

// 同一份提示词正文；只换输出语言句、对话角色标签和长度上限。zh 正文与改前逐字相同。
const TRANSCRIPT_LABEL: Record<SessionTitleLanguage, { user: string; assistant: string }> = {
  zh: { user: '用户', assistant: '助手' },
  en: { user: 'User', assistant: 'Assistant' },
};
const SUGGESTION_LENGTH_RULE: Record<SessionTitleLanguage, string> = {
  zh: '15 字以内',
  en: 'at most 8 words',
};
// 与会话标题的 CJK_CHAR 同一字符类，但不用 /g，避免 test() 的 lastIndex 串行漏判。
const CJK_SCRIPT = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;

function matchesUiScript(line: string, language: SessionTitleLanguage): boolean {
  const hasCjk = CJK_SCRIPT.test(line);
  return language === 'en' ? !hasCjk : hasCjk;
}

const CONTEXT_MESSAGE_LIMIT = 10;
const USER_MESSAGE_MAX_CHARS = 600;
const ASSISTANT_MESSAGE_MAX_CHARS = 300;

// 禁止词 + 紧跟的「用/使用/运行…」动词 + 被禁的 ASCII 名称（可用 / 、, 和 或 and or 连接）
// 如 "不要用 Bash/curl" → bash, curl；"don't use curl or wget" → curl, wget。
// 只认这种明确的「别用某工具」结构，"don't put it in the README"、"No, use Python"、「识别 Excel」不触发。
const BAN_NAME = '[A-Za-z][A-Za-z0-9_.-]{2,}';
// 列表续接处遇到动词/虚词即停（"curl, use wget" 停在 use；"curl and then retry" 停在 then），不再往后收词
const STOP_WORDS = 'use|using|then|just|instead|retry|try|run|please|but|so|because|it|this|that|the|a|an|also|again|and|or|with|for|any|them|those|you';
const BAN_TERM_PATTERN = new RegExp(
  '(?:(?:不要|不用|禁止|不许|不能|不准|别)(?:再用|再|使用|调用|执行|运行|用|跑|去)|' +
    "\\b(?:don['’]t|do not|never|must not)\\s+(?:use|using|run|call|rely on)\\b)\\s*" +
    `(${BAN_NAME}(?:\\s*(?:[/、,，&]|和|或|(?:and|or)\\b)\\s*(?!(?:${STOP_WORDS})\\b)${BAN_NAME})*)`,
  'gi',
);
const NON_TOOL_WORDS = new Set([...STOP_WORDS.split('|'), 'tool', 'tools', 'command', 'commands', 'line', 'anything']);

function extractBannedTerms(messages: Array<{ role: string; content?: string }>): string[] {
  const terms = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'user' || !m.content) continue;
    for (const match of m.content.matchAll(BAN_TERM_PATTERN)) {
      for (const word of match[1].match(new RegExp(BAN_NAME, 'g')) ?? []) {
        const lower = word.toLowerCase().replace(/[.-]+$/, '');
        if (lower.length >= 3 && !NON_TOOL_WORDS.has(lower)) terms.add(lower);
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
    const language = readUiLanguage();
    const labels = TRANSCRIPT_LABEL[language];
    // Extract recent conversation context
    const windowed = messages
      .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
      .slice(-CONTEXT_MESSAGE_LIMIT);
    const recentMessages = windowed
      .map(m => {
        const limit = m.role === 'user' ? USER_MESSAGE_MAX_CHARS : ASSISTANT_MESSAGE_MAX_CHARS;
        const label = m.role === 'user' ? labels.user : labels.assistant;
        return `${label}: ${stripTelemetryRecoveryNotice(m.content || '').slice(0, limit)}`;
      })
      .join('\n');

    if (!recentMessages) return [];

    const { quickTask } = await import('../../model/quickModel');

    const prompt = `Write every suggestion in ${LANGUAGE_NAME[language]}.
根据以下对话，生成 2-3 个用户可能的后续提问或指令。要求：
- 每行一个建议，不要编号
- 简短（${SUGGESTION_LENGTH_RULE[language]}），以动词开头
- 基于对话上下文，是合理的下一步操作
- 不要重复已经完成的事情
- 尊重用户在对话中提出的任何拒绝、禁止、限制或偏好，后说的优先；绝不建议被拒绝的操作，也不建议它的同义做法
- 面向不懂技术的普通人，用日常用语；不要出现命令行、终端、端口、进程、shell、ping、工具、后台任务、代理等技术字眼，除非用户自己用过这些词；多用「把内容发给我」「换个办法」这类大白话

对话：
${recentMessages}

后续建议：`;
    logger.debug('Context suggestion prompt language', {
      language,
      rule: `Write every suggestion in ${LANGUAGE_NAME[language]}.`,
    });

    const result = await quickTask(prompt);
    if (!result.success || !result.content) return [];

    const lines = result.content
      .split('\n')
      .map(l => l.replace(/^[-•\d.]\s*/, '').trim())
      .filter(l => l.length > 2 && l.length < 50);

    const scriptMatched = lines.filter(l => matchesUiScript(l, language));
    if (scriptMatched.length < lines.length) {
      logger.debug('Dropped suggestions whose script mismatches the UI language', {
        reason: language === 'en' ? 'contains-cjk' : 'no-cjk',
        dropped: lines.length - scriptMatched.length,
      });
    }

    const banned = extractBannedTerms(windowed);
    const allowed = banned.length
      ? scriptMatched.filter(l => !banned.some(t => mentionsTerm(l, t)))
      : scriptMatched;
    if (allowed.length < scriptMatched.length) {
      logger.debug('Dropped suggestions containing user-banned terms', { dropped: scriptMatched.length - allowed.length });
    }

    const suggestions = allowed.slice(0, 3).map((text, i) => ({
      id: `ctx-${i}`,
      text,
      source: 'context' as const,
    }));
    logger.debug('Context suggestions ready', {
      language,
      count: suggestions.length,
      texts: suggestions.map(s => s.text),
    });
    return suggestions;
  } catch (error) {
    logger.debug('Failed to generate context suggestions', { error });
    return [];
  }
}
