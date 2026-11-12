// pack 候选的范围匹配与打分（从 memoryEntryRuntime 拆出，god-file max-lines 门）。
// 项目记忆匹配走仓库身份键（N-MEM-PROJECTKEY）：同仓 worktree 共享记忆分区。
import type { MemoryEntry, MemoryPackRequest } from '../../shared/contract/memory';
import { memoryUsageGain } from '../../shared/memoryUsageGain';

/** 项目记忆匹配上下文：请求侧与条目侧的仓库身份键（N-MEM-PROJECTKEY）。 */
export interface ProjectMemoryMatch {
  requestKey: string | undefined;
  entryKeys: ReadonlyMap<string, string>;
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function tokenizeQuery(query: string): string[] {
  const text = normalizeText(query);
  if (!text) return [];
  const tokens = text.split(/[^a-z0-9_\u4e00-\u9fff]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  return Array.from(new Set(tokens)).slice(0, 12);
}

function projectMemoryMatches(entry: MemoryEntry, match: ProjectMemoryMatch): boolean {
  if (!entry.projectPath) return true;
  const entryKey = match.entryKeys.get(entry.id);
  return Boolean(match.requestKey && entryKey && entryKey === match.requestKey);
}

export function scopeMatches(entry: MemoryEntry, request: MemoryPackRequest, match: ProjectMemoryMatch): boolean {
  if (entry.scope === 'global') return true;
  if (entry.scope === 'project') return projectMemoryMatches(entry, match);
  if (entry.scope === 'session') return Boolean(request.sessionId && entry.sessionId === request.sessionId);
  return false;
}

export function scoreMemoryEntry(entry: MemoryEntry, request: MemoryPackRequest, match: ProjectMemoryMatch, tokens: string[]): {
  score: number;
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];
  if (entry.status === 'active') {
    score += 25;
    reasons.push('active');
  }
  if (entry.scope === 'global') {
    score += 4;
    reasons.push('global');
  }
  if (entry.projectPath && projectMemoryMatches(entry, match)) {
    score += 16;
    reasons.push('project-match');
  }
  if (request.sessionId && entry.sessionId === request.sessionId) {
    score += 10;
    reasons.push('session-match');
  }
  if (entry.source.sourceOfTruth === 'light_file') {
    score += 8;
    reasons.push('light-source');
  }
  score += Math.max(0, Math.min(12, entry.confidence * 12));

  if (tokens.length > 0) {
    const title = normalizeText(entry.title);
    const summary = normalizeText(entry.summary);
    const content = normalizeText(entry.content);
    let matched = 0;
    for (const token of tokens) {
      if (title.includes(token)) {
        score += 12;
        matched++;
      } else if (summary.includes(token)) {
        score += 8;
        matched++;
      } else if (content.includes(token)) {
        score += 4;
        matched++;
      }
    }
    if (matched > 0) reasons.push(`query-match:${matched}`);
    else score -= 12;
  }

  // 使用增益与 searchMemories 同一公式；无使用数据时恒为 1，旧序/旧分不变。
  if (score > 0) score *= memoryUsageGain(entry, Date.now());

  return { score, reasons };
}

/**
 * 合并 light 文件条目与 DB 条目：DB 里同 id 的 light 镜像行被丢弃，但 MemoryRead 的使用度
 * 回写在镜像行上，丢弃前把它搬到 light 条目上，否则最常用的 light 记忆永远没有使用度。
 */
export function mergeLightWithMirrorUsage(lightEntries: MemoryEntry[], dbEntries: MemoryEntry[]): MemoryEntry[] {
  const mirrors = new Map(dbEntries.filter((e) => e.source.sourceOfTruth === 'light_file').map((e) => [e.id, e]));
  const light = lightEntries.map((entry) => {
    const mirror = mirrors.get(entry.id);
    return mirror ? { ...entry, accessCount: mirror.accessCount, lastAccessedAt: mirror.lastAccessedAt } : entry;
  });
  const lightIds = new Set(lightEntries.map((e) => e.id));
  return [...light, ...dbEntries.filter((e) => !(e.source.sourceOfTruth === 'light_file' && lightIds.has(e.id)))];
}
