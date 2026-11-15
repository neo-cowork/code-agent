import { homedir } from 'node:os';

import type { ModelConfig } from '../../../shared/contract';
import type { DatabaseService } from '../core/databaseService';
import { shouldKeepLocalTitleOverCloud } from '../../../shared/sessionTitlePlaceholder';

const TELEMETRY_PROMPT_CORRELATION_WINDOW_MS = 60_000;

function isSameTurnByTimestamp(
  messageTimestamp: number | string | undefined,
  telemetryStartTime: number | string,
): boolean {
  const messageTime = Number(messageTimestamp);
  const telemetryTime = Number(telemetryStartTime);
  return Number.isFinite(messageTime)
    && Number.isFinite(telemetryTime)
    && messageTime <= telemetryTime
    && telemetryTime - messageTime <= TELEMETRY_PROMPT_CORRELATION_WINDOW_MS;
}

function findClosestPromptTurnIndex(
  existingRows: Array<{ timestamp?: number | string }>,
  telemetryStartTime: number | string,
): number {
  let closestIndex = -1;
  let closestTimestamp = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < existingRows.length; index++) {
    const timestamp = Number(existingRows[index].timestamp);
    if (
      isSameTurnByTimestamp(existingRows[index].timestamp, telemetryStartTime)
      && timestamp > closestTimestamp
    ) {
      closestIndex = index;
      closestTimestamp = timestamp;
    }
  }
  return closestIndex;
}

export function findMissingTelemetryPromptRows<
  T extends { user_prompt: string; start_time: number | string },
>(
  telemetryRows: T[],
  existingRows: Array<{ content: string; timestamp?: number | string }>,
): T[] {
  const unmatchedExistingRows = existingRows.map((row) => ({
    ...row,
    normalizedContent: normalizePromptForBackfill(row.content),
  }));
  // Prompts already paired to a persisted user message. A later telemetry row
  // with the same normalized text is a resumed attempt, not a missing message.
  const matchedPromptKeys = new Set<string>();

  return telemetryRows.filter((row) => {
    const key = normalizePromptForBackfill(row.user_prompt);
    const exactMatchIndex = unmatchedExistingRows.findIndex(
      (existing) => existing.normalizedContent === key,
    );
    if (exactMatchIndex >= 0) {
      unmatchedExistingRows.splice(exactMatchIndex, 1);
      matchedPromptKeys.add(key);
      return false;
    }

    if (matchedPromptKeys.has(key)) {
      return false;
    }

    // telemetry user_prompt is guarded diagnostic data. Its path/PII masking is lossy,
    // so correlate the already-persisted original by turn time before declaring it absent.
    const timestampMatchIndex = findClosestPromptTurnIndex(
      unmatchedExistingRows,
      row.start_time,
    );
    if (timestampMatchIndex >= 0) {
      unmatchedExistingRows.splice(timestampMatchIndex, 1);
      return false;
    }
    return true;
  });
}

// SessionRepository 持久化只存 provider+model（apiKey 不入库）；剥离后让
// SessionManager 返回的内存 session 与 DB 读回（fromRow）语义一致。
export function sanitizeModelConfigForSession(config: ModelConfig): ModelConfig {
  const { apiKey: _omitted, ...rest } = config;
  void _omitted;
  return rest;
}

// 仅本模块内部使用：对外只暴露 findMissingTelemetryPromptRows（导出它会被 knip 死导出棘轮判红）
function normalizePromptForBackfill(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .trim()
    // 消息表可能已把 ~/ 展开成绝对主目录，而 telemetry 保留模型原文。
    .replace(/~\//g, `${homedir()}/`)
    .replace(/\bhttps?:\/\/[^\s<>"'`]+/giu, (rawUrl) => {
      // 两侧统一走 WHATWG URL canonicalization；解析失败则保持原文。
      try {
        return new URL(rawUrl).toString();
      } catch {
        return rawUrl;
      }
    });
}

// ============================================================================
// 云端 sessions 行标题回灌取值（FB-1089 / N-FIX-SESSION-TITLE-REVERTS-TO-RAW-MESSAGE）
// 云端行的 title 只在新会话时由 web 首轮写入过自动档（syncSupabaseSessionRow 只在
// isNewSession 写 title，此后每轮只顶 updated_at），本地智能标题/用户命名一旦定档，
// 回灌时不能被时间戳更新的自动档顶回。判定细节在 shared 的
// shouldKeepLocalTitleOverCloud；这里只负责从本地库取参（现标题 + 首条用户消息）。
// ============================================================================

/** 首条用户消息在消息表头部的扫描窗口；用户消息总在会话头部，超窗视为无源文本。 */
const TITLE_SOURCE_SCAN_MESSAGES = 12;

function firstVisibleUserMessage(db: DatabaseService, sessionId: string): string {
  const first = db
    .getMessages(sessionId, TITLE_SOURCE_SCAN_MESSAGES)
    .find((message) => message.role === 'user' && !message.isMeta && message.content.trim().length > 0);
  return first?.content ?? '';
}

/**
 * 云端会话行回灌本地时 title 列的取值：本地已定档且云端是自动临时档时保留本地
 * 标题，其余（本地无行、本地未定档、云端是真改名）照旧用云端值。
 * 查询不按 owner 过滤——create 分支按 owner 过滤查不到的行（user_id NULL/异主）
 * 同样可能有已定档标题。
 */
export function resolveCloudSessionTitle(db: DatabaseService, sessionId: string, cloudTitle: string): string {
  const local = db.getSession(sessionId, { includeDeleted: true });
  if (!local) return cloudTitle;
  return shouldKeepLocalTitleOverCloud(local.title, cloudTitle, firstVisibleUserMessage(db, sessionId))
    ? local.title
    : cloudTitle;
}
