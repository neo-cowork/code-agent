// ============================================================================
// ReadOnlyProbe hook — ToolExecutor.execute 里「已知安全命令」捷径旁的唯一入口。
//
// 调用方已保证所有 deny / 强制确认 / 受保护路径 / 重试洗白闸门都过了；这里再做三件事：
//   1. 开关（设置 permissions.readOnlyProbePlan !== false 且 CODE_AGENT_READONLY_PROBE !== off）。关 → 编译器不被调用。
//   2. 用户级 deny/ask 规则对整条命令及每个子命令片段逐一复核，命中任何非 allow 规则 → 放弃。
//   3. 编译 → 进程内执行；任何不确定返回 null，调用方原样走审批卡。
// ============================================================================

import * as os from 'os';
import { getConfigService } from '../services/core/configService';
import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import { getPolicyEngine } from '../permissions/policyEngine';
import { resolveEffectivePolicyRules } from '../permissions/runPolicySnapshot';
import { compileReadOnlyProbePlan } from '../security/readOnlyProbePlan';
import { executeReadOnlyProbePlan } from '../security/readOnlyProbeExecutor';

const logger = createLogger('ReadOnlyProbe');
const BASH_SPELLINGS = ['Bash', 'bash'] as const;

export interface ReadOnlyProbeInput {
  command: string;
  workingDirectory: string;
  workspaceRoot?: string;
  sessionId?: string;
  currentAttachments?: Array<{ path?: string }>;
}

export function isReadOnlyProbeEnabled(): boolean {
  if (/^(off|0|false)$/i.test(process.env.CODE_AGENT_READONLY_PROBE ?? '')) return false;
  try {
    return getConfigService().getSettings().permissions?.readOnlyProbePlan !== false;
  } catch {
    return true;
  }
}

function sessionAuthority(input: ReadOnlyProbeInput): { userTexts: string[]; attachmentPaths: string[] } {
  const userTexts: string[] = [];
  const attachmentPaths = (input.currentAttachments ?? []).map((a) => a.path).filter((p): p is string => Boolean(p));
  if (input.sessionId) {
    try {
      for (const message of getDatabase().getMessages(input.sessionId)) {
        if (message.role !== 'user') continue;
        if (typeof message.content === 'string') userTexts.push(message.content);
        for (const a of message.attachments ?? []) if (a.path) attachmentPaths.push(a.path);
      }
    } catch (err) {
      logger.warn('readonly_probe_plan_session_unreadable', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { userTexts, attachmentPaths };
}

function userRulesAllow(texts: string[], sessionId?: string): boolean {
  const rules = resolveEffectivePolicyRules(sessionId);
  return texts.every((command) => BASH_SPELLINGS.every((tool) => {
    const matched = getPolicyEngine().evaluate({
      tool, level: 'execute', description: `tool: ${tool}`, command, sessionId,
    }, rules).matchedRule;
    return !matched || matched.action === 'allow';
  }));
}

/** 命中返回可直接作为 Bash 结果的输出文本；未命中 / 无法证明返回 null。 */
export async function tryReadOnlyProbe(input: ReadOnlyProbeInput): Promise<{ output: string; programs: string[] } | null> {
  if (!isReadOnlyProbeEnabled()) return null;
  const plan = compileReadOnlyProbePlan(input.command, { homeDir: os.homedir(), platform: process.platform });
  if (!plan) return null;
  const programs = [...new Set(plan.steps.map((s) => s.program))];
  if (!userRulesAllow([input.command, ...plan.steps.map((s) => s.source)], input.sessionId)) {
    logger.info('readonly_probe_plan_miss', { cause: 'user-or-builtin-rule', programs });
    return null;
  }
  const result = await executeReadOnlyProbePlan(plan, {
    workingDirectory: input.workingDirectory,
    workspaceRoot: input.workspaceRoot,
    homeDir: os.homedir(),
    ...sessionAuthority(input),
  });
  // 非零退出码的失败呈现（Command exited with code N）由真 Bash 路径负责：放弃，让原链处理。
  if ('aborted' in result) {
    logger.info('readonly_probe_plan_miss', { cause: result.aborted, programs });
    return null;
  }
  if (result.exitCode !== 0) {
    logger.info('readonly_probe_plan_miss', { cause: 'non-zero-exit', programs });
    return null;
  }
  const body = result.stderr ? `${result.stdout}\n[stderr]: ${result.stderr}` : result.stdout;
  return {
    output: `[cwd: ${input.workingDirectory}]\n${body}`,
    programs,
  };
}
