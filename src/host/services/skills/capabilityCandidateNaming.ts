// ============================================================================
// 候选能力的「模型分」—— 只起人话名 + 写一句「它是什么」（N-CAP1 / F1）
// ============================================================================
// 硬约束（方案 §二.5(1续A)）：模型产出**仅展示，绝不参与排序**。
// 让它写描述——错了人一眼看出；让它定优先级——错了人看不出。
// 因此本文件只写 displayName / summary 两个展示字段，
// 排序主键 mechanicalScoreOf() 里不出现这两个字段。
//
// 时机：打开候选列表时按需补齐（懒补），补完落账本缓存。
// 不在后台跑、不在每轮跑——否则就是拿用户的钱给一张没人看的表起名。

import { CAPABILITY_CANDIDATES } from '../../../shared/constants';
import type { CapabilityCandidateRecord } from '../../../shared/contract/capabilityCandidate';
import { getCapabilityCandidateStore } from './capabilityCandidateStore';
import { createLogger } from '../infra/logger';
import { detectMessageLanguage, type SessionTitleLanguage } from '../../../shared/sessionTitlePrompt';
import { readUiLanguage } from '../../session/sessionTitleHostPrompt';

const logger = createLogger('CapabilityCandidateNaming');

const NAMING_MAX_TOKENS = 512;

const FALLBACK_INTENTS: Array<{ pattern: RegExp; name: string; nameEn: string }> = [
  { pattern: /\b(?:pptx?|slides?)\b|幻灯|演示(?:文稿|稿)/i, name: '制作演示文稿', nameEn: 'Create presentation slides' },
  { pattern: /截图|截屏|screenshot|screencapture/i, name: '截取并分析屏幕', nameEn: 'Capture and analyze the screen' },
  { pattern: /\b(?:csv|xlsx?|excel)\b|表格|销售额|员工数据/i, name: '分析并整理表格', nameEn: 'Analyze and organize spreadsheets' },
  { pattern: /\bgit\b|提交记录|仓库状态/i, name: '检查代码仓库状态', nameEn: 'Check the code repository state' },
  { pattern: /会议|meeting/i, name: '创建并管理会议', nameEn: 'Create and manage meetings' },
  { pattern: /记忆|memory/i, name: '保存并整理记忆', nameEn: 'Store and organize memories' },
  { pattern: /网页|联网|搜索|\bsearch\b|https?:\/\//i, name: '搜索并整理信息', nameEn: 'Search and organize information' },
  { pattern: /配置文件|\bconfig(?:uration)?\b/i, name: '读取并整理配置', nameEn: 'Read and organize configuration' },
  { pattern: /读取|查找|列出|\bread\b|\bfind\b|\blist\b/i, name: '查找并读取文件', nameEn: 'Find and read files' },
  { pattern: /创建.*文件|写入|保存|\bwrite\b|\bsave\b/i, name: '创建并更新文件', nameEn: 'Create and update files' },
];

/** 兜底名语言：跟模型路径同一规则——用户原话判得出语言就跟原话，判不出跟 UI。 */
function fallbackLanguage(record: CapabilityCandidateRecord): SessionTitleLanguage {
  return detectMessageLanguage(record.sampleUserMessages.join(' ')) ?? readUiLanguage();
}

/** 人话兜底名：模型不可用 / 调用失败时也落可读名字，不暴露工具组合。 */
export function fallbackName(record: CapabilityCandidateRecord, language: SessionTitleLanguage = 'zh'): string {
  if (language === 'en') return fallbackNameEn(record);
  const evidence = record.sampleUserMessages.join(' ');
  const matched = FALLBACK_INTENTS.find(({ pattern }) => pattern.test(evidence));
  if (matched) return matched.name;

  const toolEvidence = record.shapeTokens.join(' ');
  if (/image|vision|blob/i.test(toolEvidence)) return '处理并整理图片';
  if (/browser|web/i.test(toolEvidence)) return '搜索并整理信息';
  if (/read|write|edit|glob|grep|directory/i.test(toolEvidence)) return '整理并更新文件';
  return '自动完成重复工作';
}

/** 英文档兜底名：与中文同一组意图 pattern，名字换成英文做事说法。 */
function fallbackNameEn(record: CapabilityCandidateRecord): string {
  const evidence = record.sampleUserMessages.join(' ');
  const matched = FALLBACK_INTENTS.find(({ pattern }) => pattern.test(evidence));
  if (matched) return matched.nameEn;

  const toolEvidence = record.shapeTokens.join(' ');
  if (/image|vision|blob/i.test(toolEvidence)) return 'Process and organize images';
  if (/browser|web/i.test(toolEvidence)) return 'Search and organize information';
  if (/read|write|edit|glob|grep|directory/i.test(toolEvidence)) return 'Organize and update files';
  return 'Automate repeated work';
}

function fallbackSummary(name: string, language: SessionTitleLanguage = 'zh'): string {
  return language === 'en' ? `${name}, as you asked` : `按用户要求${name}`;
}

const NAMING_LANGUAGE_LABEL: Record<SessionTitleLanguage, string> = { zh: '中文', en: 'English' };

function buildPrompt(records: CapabilityCandidateRecord[], uiLanguage: SessionTitleLanguage): string {
  const items = records.map((record, index) => [
    `[${index + 1}]`,
    `重复次数：${record.occurrences}`,
    `每次用到：${record.shapeTokens.join(', ')}`,
    `步骤顺序样例：${record.variants.slice(0, 2).join(' | ')}`,
    record.sampleUserMessages.length > 0
      ? `用户当时说的话：${record.sampleUserMessages.join(' / ')}`
      : '用户原话：无',
    // 与会话标题同一规则：跟随用户原话的语言，判不出才用界面语言
    `名字和说明的语言：${NAMING_LANGUAGE_LABEL[detectMessageLanguage(record.sampleUserMessages.join(' ')) ?? uiLanguage]}`,
  ].join('\n')).join('\n\n');

  return [
    '下面每一条，都是同一个助手反复用一组工具拼凑完成的同一类事情。',
    '请给每一条起一个「人话名字」，并写一句「它是什么」。',
    '',
    '要求：',
    '- 名字 ≤ 12 个字（英文 ≤ 6 个词），用做事的说法（例：把截图里的表格转成 Excel），不要用工具名、不要用命令名。',
    '- 说明 ≤ 30 个字（英文 ≤ 15 个词），说清这件事是干什么的。',
    '- 名字和说明用每条标注的「名字和说明的语言」写。',
    '- 不要评价值不值得做、不要排优先级、不要建议怎么实现。',
    '- 严格输出 JSON 数组，不要代码块围栏，格式：',
    '  [{"index":1,"name":"...","summary":"..."}]',
    '',
    items,
  ].join('\n');
}

interface NamingReply {
  index?: number;
  name?: string;
  summary?: string;
}

function parseNamingReply(content: string): NamingReply[] {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed as NamingReply[] : [];
  } catch {
    return [];
  }
}

/**
 * 给还没有人话名的候选补名字。模型只处理定额首批，其余及失败项落人话兜底。
 * 返回真正写入名字的条数（给调用方判断要不要重新读列表）。
 */
export async function fillMissingNames(records: CapabilityCandidateRecord[]): Promise<number> {
  const pending = records.filter((record) => !record.displayName);
  if (pending.length === 0) return 0;
  const modelPending = pending.slice(0, CAPABILITY_CANDIDATES.AGENT_NOTICE_MAX_ENTRIES * 2);

  let content: string | undefined;
  try {
    const { quickTask, isQuickModelAvailable } = await import('../../model/quickModel');
    if (isQuickModelAvailable()) {
      const result = await quickTask(buildPrompt(modelPending, readUiLanguage()), NAMING_MAX_TOKENS);
      if (result.success && result.content) {
        content = result.content;
      } else {
        logger.debug('候选能力起名使用人话兜底（模型调用失败）', {
          failureReason: result.failureReason,
          status: result.status,
        });
      }
    }
  } catch (error) {
    logger.debug('候选能力起名使用人话兜底（模型不可用）', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const store = getCapabilityCandidateStore();
  const replies = new Map(
    (content ? parseNamingReply(content) : [])
      .filter((reply) => Number.isInteger(reply.index) && (reply.index ?? 0) > 0)
      .map((reply) => [reply.index as number, reply]),
  );
  let written = 0;
  for (const [index, target] of pending.entries()) {
    const reply = replies.get(index + 1);
    const modelName = typeof reply?.name === 'string' ? reply.name.trim() : '';
    // 兜底名语言跟模型路径同一规则（用户原话优先，判不出跟 UI）
    const language = fallbackLanguage(target);
    const name = modelName || fallbackName(target, language);
    const current = store.get(target.clusterKey);
    if (!current) continue;
    store.put({
      ...current,
      displayName: name.slice(0, 40),
      summary: typeof reply?.summary === 'string' && reply.summary.trim()
        ? reply.summary.trim().slice(0, 80)
        : current.summary || fallbackSummary(name, language),
    });
    written += 1;
  }
  // LIST 紧接着会把新名字返回给 renderer；这里同时等写盘完成，避免只有内存态成功。
  if (written > 0) await store.flush();
  return written;
}
