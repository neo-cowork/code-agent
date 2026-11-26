// ============================================================================
// N-FIX-TELEMETRY-RECOVERY-NOTICE-RESIDUE-SKILLDRAFT-TITLE — 静态门
// 凡是把「用户消息原文」变成会话标题 / 任务文件夹名 / 摘要 / skill 草稿的模块，
// 必须走两道共用入口之一：
//   (a) stripTelemetryRecoveryNoticeOrResidue（技能复盘 / 文件夹命名 / 审批任务名）
//   (b) sessionTitleSource（标题派生；sessionManager / CLI / 回填 / 规则摘要经它继承）
// 门有两层：
//   1) REQUIRED：点名的出口文件必须引用对应入口符号，改丢即红；
//   2) DISCOVERY：src 下新定义会话标题 / 复盘片段 / 蒸馏信号类函数、且不在
//      REQUIRED/ALLOWED 清单里的文件，直接红——新增未登记的原文出口绕不过本门。
// withTelemetryRecoveryNoticeForModel 故意把提示加回模型请求（messageBuild /
// compaction / checkpoint），是唯一被点名豁免的「再加回」方向，ALLOWED 里写明。
// ============================================================================

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** 点名出口：文件 → 必须引用的入口符号（缺了就红）。 */
const REQUIRED: Readonly<Record<string, string>> = {
  // ── 入口自身 ──
  'src/shared/sessionTitlePlaceholder.ts': 'stripTelemetryRecoveryNoticeOrResidue', // 定义 sessionTitleSource 入口
  'src/shared/telemetryRecovery.ts': 'stripTelemetryRecoveryNoticeOrResidue',
  // ── 技能复盘链（入口 a）──
  'src/host/agent/runtime/learningPipeline.ts': 'stripTelemetryRecoveryNoticeOrResidue',
  'src/host/lightMemory/conversationReview.ts': 'stripTelemetryRecoveryNoticeOrResidue',
  'src/host/services/skills/distillService.ts': 'stripTelemetryRecoveryNoticeOrResidue',
  // ── 标题链（入口 b：经 sessionTitleSource / 其降级产物继承）──
  'src/host/services/infra/sessionManager.ts': 'sessionTitleSource',
  'src/cli/session.ts': 'sessionTitleSource',
  'src/host/telemetry/telemetrySessionTitleBackfill.ts': 'deriveFallbackSessionTitle',
  // ── 文件夹命名 / 审批任务名（入口 a 的同族派生）──
  'src/host/config/sessionWorkDirectory.ts': 'stripTelemetryRecoveryNoticeOrResidue',
  'src/host/services/sessionAutomation/parkedApprovalTaskTitle.ts': 'stripTelemetryRecoveryNoticeOrResidue',
  // ── 已修出口：钉住不许回退 ──
  'src/host/lightMemory/conversationJudge.ts': 'stripTelemetryRecoveryNotice',
  'src/host/lightMemory/recentConversations.ts': 'isTelemetryRecoveryNoticeResidue',
  'src/host/services/core/promptSuggestions.ts': 'stripTelemetryRecoveryNotice',
  'src/renderer/components/features/chat/TraceNodeRenderer.tsx': 'stripTelemetryRecoveryNotice',
};

/** 非原文出口的登记豁免：文件 → 不走入口的理由。 */
const ALLOWED: Readonly<Record<string, string>> = {
  'src/host/agent/runtime/contextAssembly/messageBuild.ts': 'withTelemetryRecoveryNoticeForModel 有意把模型专属提示加回模型请求（非用户面派生）',
  'src/host/context/compactionService.ts': 'withTelemetryRecoveryNoticeForModel 有意加回模型专属提示',
  'src/host/agent/checkpointWriterService.ts': 'withTelemetryRecoveryNoticeForModel 有意加回模型专属提示',
  'src/web/routes/agent.ts': 'buildSessionTitle 的输入是当次请求的 live prompt，不是落库的还原消息',
  'src/host/tools/modules/delegation/delegatedSessionTitle.ts': 'deriveDelegatedSessionTitle 的直接输入是模型写的委派任务文本；读库内 user 消息的调用方 parkedApprovalTaskTitle.ts 在 REQUIRED 里',
  'src/host/session/sessionTitleHostPrompt.ts': '组装小模型标题指令；正文由调用方传清洗后的 titleSource',
  'src/shared/sessionTitlePrompt.ts': '同上，标题指令模板，不读原文',
  'src/host/services/infra/sessionFolderName.ts': '包装 deriveInitMemorySessionTitle，输入是清洗后的 titleSource',
  'src/host/services/infra/sessionManagerNormalization.ts': '只在既有标题间取舍（shouldKeepLocalTitleOverCloud），不读原文',
  'src/host/services/infra/sessionTitleCloudPush.ts': '把既有标题推云端，不读原文',
  'src/host/services/infra/notificationService.ts': '读 sessions.title，不读原文',
  'src/host/services/sessionAutomation/sessionAutomationService.ts': '读 sessions.title，不读原文；任务名走 REQUIRED 的 approvalTaskTitle',
  'src/host/services/core/repositories/sessionSearchMeta.ts': '检索既有标题的 FTS 入口，不读原文',
  'src/host/services/skills/distillSignalStore.ts': '存调用方给定的 patternKey（learningPipeline 已清洗），不读原文',
  'src/host/services/core/database/migrations/distillSignals.ts': '数据库迁移',
  'src/host/cron/cronNormalizers.ts': 'cron 结构化标题格式化，不读原文',
  'src/shared/cronSessionTitle.ts': 'cron 结构化标题解析/本地化',
  'src/shared/i18n/cronNotificationTitle.ts': 'cron 通知文案',
  'src/renderer/utils/sessionPresentation.ts': '展示层（既有标题），不在本门范围',
  'src/renderer/utils/sessionTitlePlaceholder.ts': '展示层占位文案',
  'src/renderer/components/features/cron/AutomationReviewInbox.tsx': '展示层组件',
};

/** 会话标题 / 复盘片段 / 蒸馏信号类的派生函数名（新增出口会被这个模式扫出来）。 */
const DERIVER_NAME = /(SessionTitle|FolderTitle|ReviewSnippet|ConversationSnippet|DistillSignal)/;
const DEFINITION_PATTERNS: readonly RegExp[] = [
  /(?:^|\n)[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g,
  /(?:^|\n)[ \t]*(?:export\s+)?(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?[(<]/g,
];

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

describe('recovery-notice derivation gate', () => {
  it('named derivation exits route through the two shared entries', () => {
    const missing: string[] = [];
    for (const [file, symbol] of Object.entries(REQUIRED)) {
      const full = path.join(repoRoot, file);
      if (!fs.existsSync(full)) {
        missing.push(`${file}: 文件不存在（门清单过期或出口被移动）`);
        continue;
      }
      if (!fs.readFileSync(full, 'utf8').includes(symbol)) {
        missing.push(`${file}: 不再引用入口符号 ${symbol}`);
      }
    }
    expect(missing, `以下原文出口绕开了共用入口：\n${missing.join('\n')}\n恢复提示会重新漏进标题/草稿。`).toEqual([]);
  });

  it('every session-title/review-snippet/distill-signal deriver in src is on a known list', () => {
    const unlisted: string[] = [];
    for (const full of listSourceFiles(path.join(repoRoot, 'src'))) {
      const rel = path.relative(repoRoot, full).split(path.sep).join('/');
      if (REQUIRED[rel] || ALLOWED[rel]) continue;
      const text = fs.readFileSync(full, 'utf8');
      const names = new Set<string>();
      for (const pattern of DEFINITION_PATTERNS) {
        for (const match of text.matchAll(pattern)) names.add(match[1]!);
      }
      const offenders = [...names].filter((name) => DERIVER_NAME.test(name));
      if (offenders.length > 0) {
        unlisted.push(`${rel}: 定义了 ${offenders.join(', ')} 却没走两道共用入口，也没登记豁免`);
      }
    }
    expect(unlisted, `发现未登记的标题/摘要/技能草稿原文出口：\n${unlisted.join('\n')}\n要么走 stripTelemetryRecoveryNoticeOrResidue / sessionTitleSource，要么在本门登记理由。`).toEqual([]);
  });
});
