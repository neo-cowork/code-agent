// ============================================================================
// Missing Attachment Turn Context (N-FIX-ATTACHMENT-NOT-IN-WORKDIR-FU1)
// ============================================================================
// 当用户在会话首轮口头提到「分析这张销售表」「看看我上传的附件」但并未实际上传文件时，
// 追加一行条件 turnSystemContext，提示助手最多检查一次当前任务文件夹；若为空则直接
// 告知未收到附件并请用户重新上传或给出文件路径，禁止去扫 ~/Downloads、~/Desktop
// 或其他任务文件夹。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Message, MessageAttachment } from '../../shared/contract';
import type { AppServiceRunOptions } from '../../shared/contract/appService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('MissingAttachmentTurnContext');

const ATTACHMENT_MENTION_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: '附件', pattern: /附件/ },
  {
    label: '这张表',
    pattern: /(?:这|那)(?:张|份)[\u4e00-\u9fa5A-Za-z0-9_-]{0,4}(?:表格|报表|数据表|工作簿|台账|账单|清单|名单|表)/,
  },
  {
    label: '这份文件',
    pattern: /(?:这|那)(?:份|篇)[\u4e00-\u9fa5A-Za-z0-9_-]{0,4}(?:文件|文档|材料|资料|合同|报告|简历|试卷|讲义|演示稿|幻灯片)/,
  },
  {
    label: '我上传的',
    pattern: /(?:我|刚|刚才|上面|前面|随信)(?:上传|发|传)(?:给你|过来|上来)?的(?:[\u4e00-\u9fa5A-Za-z0-9_-]{0,12})(?:文件|表格|表|文档|图片|图|截图|资料|材料|数据|报告|简历|合同|附件)/,
  },
  {
    label: 'attached',
    pattern: /\b(?:attached|attachment|attachments)\b/i,
  },
  {
    label: 'uploaded',
    pattern: /\b(?:my|the)\s+uploaded\s+(?:file|files|sheet|spreadsheet|table|document|documents|image|images|screenshot|csv|xlsx|pdf|report|data|attachment|attachments)\b/i,
  },
];

// 创建/起草类动词出现在指示词之前，说明是「写一份新的」而不是「看已有的」
const CREATION_VERB_RE = /(?:写|做|设计|生成|制作|整理成|列出?|起草|创建|新建|画|编一|拟|草拟|出一)/;

// 显式路径（绝对路径 / ~/ 路径 / Windows 盘符路径）
const EXPLICIT_PATH_RE = /(?:^|[\s"'`（(【[])(?:~\/[^\s"'`）)】\]]+|\/(?:Users|home|tmp|var|opt|etc|Volumes|private|mnt|srv|root)\/[^\s"'`）)】\]]+|[A-Za-z]:[\\/][^\s"'`）)】\]]+)/;

// 带常见文件扩展名的文件名
const FILE_WITH_EXTENSION_RE = /(?<![A-Za-z0-9_/@.-])([^\s"'`<>|*?\\/]+\.(?:xlsx|xls|csv|tsv|pdf|docx|doc|pptx|ppt|txt|md|json|yaml|yml|xml|html|htm|png|jpg|jpeg|gif|webp|svg|zip|tar|gz|numbers|pages|key|py|js|ts|sql|log|rtf|epub))\b/gi;

const MISSING_ATTACHMENT_TURN_SYSTEM_CONTEXT_LINE =
  '本轮未收到任何上传附件。最多检查一次当前任务文件夹（ListDirectory 或 Glob）；如果里面没有目标文件，立刻用与用户消息相同的语言简明告诉用户未收到该文件，请对方重新上传或直接提供文件路径；绝对不要调用任何工具去搜索 ~/Downloads、~/Desktop、上级目录或其他任务文件夹。';

interface MissingAttachmentDetectionResult {
  matched: boolean;
  keyword?: string;
}

function expandHome(rawPath: string): string {
  if (rawPath.startsWith('~/')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

function hasExistingReferencedFile(userText: string, workingDirectory?: string): boolean {
  if (EXPLICIT_PATH_RE.test(userText)) {
    return true;
  }
  const matches = userText.matchAll(FILE_WITH_EXTENSION_RE);
  for (const match of matches) {
    const fileName = match[1];
    if (!fileName) continue;
    const candidates: string[] = [];
    if (workingDirectory) {
      candidates.push(path.resolve(workingDirectory, fileName));
    }
    candidates.push(path.resolve(expandHome(fileName)));
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return true;
        }
      } catch {
        // ignore stat errors
      }
    }
  }
  return false;
}

function isTaskFolderEmpty(workingDirectory?: string): boolean {
  if (!workingDirectory) return true;
  try {
    if (!fs.existsSync(workingDirectory)) return true;
    const entries = fs.readdirSync(workingDirectory).filter(
      (name) => !name.startsWith('.') || name === '.env.example',
    );
    return entries.length === 0;
  } catch {
    return true;
  }
}

function detectMissingAttachmentMention(
  userText: string,
  attachmentsCount: number,
  options?: {
    hasEarlierAttachments?: boolean;
    isSubsequentTurn?: boolean;
    workingDirectory?: string;
  },
): MissingAttachmentDetectionResult {
  if (attachmentsCount > 0) return { matched: false };
  if (options?.hasEarlierAttachments || options?.isSubsequentTurn) return { matched: false };
  const trimmed = userText.trim();
  if (!trimmed) return { matched: false };
  if (hasExistingReferencedFile(trimmed, options?.workingDirectory)) {
    return { matched: false };
  }

  for (const { label, pattern } of ATTACHMENT_MENTION_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match?.[0]) {
      const before = trimmed.slice(0, match.index ?? 0);
      if (label !== '附件' && CREATION_VERB_RE.test(before)) continue;
      return { matched: true, keyword: match[0] || label };
    }
  }

  // File-name trigger: the text names a file with a known extension that does
  // NOT exist in the working directory (the existing-file check already ran
  // above and returned false). Skip if a creation verb precedes the filename.
  const fileMatches = [...trimmed.matchAll(FILE_WITH_EXTENSION_RE)];
  for (const fm of fileMatches) {
    const fileName = fm[1];
    if (!fileName) continue;
    const before = trimmed.slice(0, fm.index ?? 0);
    if (CREATION_VERB_RE.test(before)) continue;
    return { matched: true, keyword: fileName };
  }

  return { matched: false };
}

function sessionHasPriorTurnOrAttachments(
  session?: {
    turnCount?: number;
    messageCount?: number;
    messages?: ReadonlyArray<Pick<Message, 'role' | 'attachments'>>;
  } | null,
): { isSubsequentTurn: boolean; hasEarlierAttachments: boolean } {
  if (!session) {
    return { isSubsequentTurn: false, hasEarlierAttachments: false };
  }
  const userMessages = session.messages?.filter((msg) => msg.role === 'user') ?? [];
  const isSubsequentTurn = (session.turnCount ?? 0) > 0
    || (session.messageCount ?? 0) > 0
    || userMessages.length > 0;
  const hasEarlierAttachments = Boolean(
    session.messages?.some((msg) => (msg.attachments?.length ?? 0) > 0),
  );
  return { isSubsequentTurn, hasEarlierAttachments };
}

export function withMissingAttachmentTurnSystemContext<T extends { turnSystemContext?: string[] } = AppServiceRunOptions>(
  options: T | undefined,
  input: {
    sessionId: string;
    userText: string;
    attachments?: ReadonlyArray<MessageAttachment>;
    session?: {
      turnCount?: number;
      messageCount?: number;
      messages?: ReadonlyArray<Pick<Message, 'role' | 'attachments'>>;
    } | null;
    workingDirectory?: string;
  },
): T | undefined {
  const { isSubsequentTurn, hasEarlierAttachments } = sessionHasPriorTurnOrAttachments(input.session);
  const detection = detectMissingAttachmentMention(
    input.userText,
    input.attachments?.length ?? 0,
    {
      hasEarlierAttachments,
      isSubsequentTurn,
      workingDirectory: input.workingDirectory,
    },
  );
  if (!detection.matched) return options;

  const taskFolderEmpty = isTaskFolderEmpty(input.workingDirectory);
  logger.info('Missing attachment mention detected on turn start', {
    sessionId: input.sessionId,
    keyword: detection.keyword,
    attachments: 0,
    taskFolderEmpty,
  });
  return {
    ...(options ?? ({} as T)),
    turnSystemContext: [...(options?.turnSystemContext ?? []), MISSING_ATTACHMENT_TURN_SYSTEM_CONTEXT_LINE],
  };
}
