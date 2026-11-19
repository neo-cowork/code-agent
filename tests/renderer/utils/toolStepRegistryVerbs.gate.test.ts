// ============================================================================
// 注册表工具步骤句门（N-FIX-STEP-ROW-GENERIC-TOOL-VERB-OFFICE-LISTDIR）
// ----------------------------------------------------------------------------
// 任何注册进 src/host/tools/modules/**/*.schema.ts 的工具名，步骤行不允许落
// domainActions.tool.operate 兜底（「请求执行/正在执行/执行了/…未成功」+
// "Request to run / Running / Ran / Could not run a tool operation"），
// 除非它在本文件的 FALLBACK_ALLOWLIST 里。
//
// 门是双向的：
//   1. 不在白名单的注册名在任一状态渲染兜底 → 红：新工具必须带步骤句（分类表或 stepLabel）。
//   2. 白名单里的名字不再渲染兜底（或已不在注册表）→ 红：把条目删掉，名单只许缩不许涨。
//
// 扫描的是 schema 注册名（含 schema stepLabel，按 toolCallMeta.ts 的解析口径传
// default），不是任意字符串 —— humanizeToolStep.test.ts 里 some_future_tool /
// unknown_tool 那几条「未知名钉兜底」的用例不受本门影响。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolSchema } from '../../../src/host/protocol/tools';
import type { ToolStepLabelKey, ToolStepStatus } from '@shared/contract';
import { humanizeToolStep } from '../../../src/renderer/utils/humanizeToolStep';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const MODULES_DIR = join(__dirname, '../../../src/host/tools/modules');
const STATUSES: ToolStepStatus[] = ['pending-approval', 'running', 'completed', 'failed'];

const GENERIC_FALLBACK = {
  zh: {
    'pending-approval': zh.toolStepHumanize.domainActions['pending-approval'].tool.operate,
    running: zh.toolStepHumanize.domainActions.running.tool.operate,
    completed: zh.toolStepHumanize.domainActions.completed.tool.operate,
    failed: zh.toolStepHumanize.domainActions.failed.tool.operate,
  },
  en: {
    'pending-approval': en.toolStepHumanize.domainActions['pending-approval'].tool.operate,
    running: en.toolStepHumanize.domainActions.running.tool.operate,
    completed: en.toolStepHumanize.domainActions.completed.tool.operate,
    failed: en.toolStepHumanize.domainActions.failed.tool.operate,
  },
} as const;

/**
 * 仍落兜底的注册名白名单 —— **只许缩不许涨**；给新名字加条目必须写原因，
 * 且加了名字的门禁评审要能看到这条注释。
 *
 * 本单（2026-11-19）只收口了 ListDirectory（分类表漏注册名）与六个 Office 文档工具；
 * 其余 59 个存量名按家族分组列在下面，逐个配句走后续单。
 */
const FALLBACK_ALLOWLIST = new Set<string>([
  // ── Office 邻接、按任务书逐个决策后留在兜底的四个 ──
  // schema 要求每次调用必带 action；带 action 时 classifyToolCall 已落 read/write 专句，
  // 空参形状是 schema 非法调用，不值得为它配句。
  'ExcelAutomate',
  // action 驱动的 PDF 多面手（generate/compress/read/…）；带 action 时走
  // domainActions.tool.create/query 等，仅缺 action 的非法调用落兜底。
  'PdfAutomate',
  // operation 动词表（check/get_active/run_macro/…）没接进 classifyGenericAction
  //（那条路径只读 action 参数）；接新参数键超出本单范围。
  'xlwings_execute',
  // 设计工作台 proposal 家族（ProposeCanvasOps/ProposeVideoOps/ProposeProjectMemory 同款），
  // 有自己的预览面与成套文案，配句走整家族的单子。
  'ProposeSlidesOps', 'ProposeCanvasOps', 'ProposeVideoOps', 'ProposeProjectMemory',
  // ── 其余存量：尚未配步骤句的注册名（本单不动）──
  'Append', 'attempt_completion', 'Blob', 'calendar', 'collect_agent', 'confirm_action',
  'decide', 'declare_deliverables', 'diagnostics', 'enter_plan_mode', 'EpisodicRecall',
  'exit_plan_mode', 'exit_role_flow', 'ExternalSearch', 'git_commit', 'git_diff',
  'git_worktree', 'github_pr', 'History', 'image_analyze', 'jira',
  'local_speech_to_text', 'lsp', 'mail', 'mcp', 'MCPUnified', 'memory_amend',
  'MemoryRead', 'MemoryWrite', 'mermaid_export', 'pdf_compress',
  'plan_recover_recent_work', 'plan_review', 'propose_role', 'propose_team_recipe',
  'qrcode_generate', 'recommend_capability', 'reminders', 'request_directory',
  'RequestDesignAutonomy', 'schedule_task', 'SessionManager', 'SkillCreate',
  'sleep_until', 'task_output', 'terminal_open', 'terminal_wait', 'wake_noop',
  'wake_on', 'wake_on_event', 'workflow', 'workflow_orchestrate',
]);

function walkSchemaFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkSchemaFiles(p));
    else if (name.endsWith('.schema.ts')) out.push(p);
  }
  return out;
}

interface RegistryTool {
  name: string;
  stepLabel?: ToolStepLabelKey;
}

async function collectRegistryTools(): Promise<RegistryTool[]> {
  const found = new Map<string, RegistryTool>();
  for (const file of walkSchemaFiles(MODULES_DIR)) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`schema 文件导入失败，门无法核对注册表：${file} → ${(err as Error).message}`, { cause: err });
    }
    for (const value of Object.values(mod)) {
      const schema = value as Partial<ToolSchema>;
      if (!schema || typeof schema !== 'object') continue;
      if (typeof schema.name !== 'string' || !schema.inputSchema) continue;
      found.set(schema.name, { name: schema.name, stepLabel: schema.stepLabel?.default });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 四态（zh+en）全部渲染 tool.operate 兜底 → 判「在兜底上」。分类与状态无关，全有或全无。 */
function rendersGenericFallback(tool: RegistryTool): boolean {
  for (const status of STATUSES) {
    if (humanizeToolStep(tool.name, {}, zh, undefined, status, tool.stepLabel) !== GENERIC_FALLBACK.zh[status]) return false;
    if (humanizeToolStep(tool.name, {}, en, undefined, status, tool.stepLabel) !== GENERIC_FALLBACK.en[status]) return false;
  }
  return true;
}

describe('注册表工具步骤句门 — 新工具不许静默落「执行了工具操作」兜底', () => {
  it('每个注册名四态都有专句，或列进只缩不涨的白名单', async () => {
    const tools = await collectRegistryTools();
    expect(tools.length).toBeGreaterThan(100);

    const unlisted = tools.filter((tool) => !FALLBACK_ALLOWLIST.has(tool.name) && rendersGenericFallback(tool));
    expect(
      unlisted.map((tool) => tool.name),
      '这些注册工具的步骤行仍渲染「执行了工具操作 / Ran a tool operation」兜底：给它们配步骤句（分类表或 schema stepLabel），或带原因登记进 FALLBACK_ALLOWLIST',
    ).toEqual([]);
  });

  it('白名单只缩不涨：不再落兜底（或已不在注册表）的条目必须删除', async () => {
    const tools = await collectRegistryTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const stale = [...FALLBACK_ALLOWLIST].filter((name) => {
      const tool = byName.get(name);
      return tool === undefined || !rendersGenericFallback(tool);
    });
    expect(
      stale,
      '这些白名单条目已不再渲染兜底（或已不在注册表）：从 FALLBACK_ALLOWLIST 删除，让名单缩下去',
    ).toEqual([]);
  });
});
