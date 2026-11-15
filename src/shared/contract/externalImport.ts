// ============================================================================
// External Import Types - 设置页「从其他 AI 应用导入」（N-EXTHISTORY-IMPORT-K1A）
// ============================================================================
//
// 检测/导入 Claude Code、Codex、Cursor、Grok Build、Qwen Code、Gemini CLI 的本机
// 数据。记忆与指令复用 memory.ts 的 harness 导入管线（memoryHarnessImport* 域
// action），本文件只补「来源检测汇总」与「技能复制」两类形状。MCP servers 是后续
// 单（N-EXTHISTORY-IMPORT-K1B-MCP）追加的 category，形状按 category 列表数据驱动。

import type { MemoryImportAdapterId } from './memory';

export type ExternalImportSourceId =
  | 'claude-code'
  | 'claude-desktop'
  | 'codex'
  | 'cursor'
  | 'grok-build'
  | 'qwen-code'
  | 'gemini-cli';

/** 技能走复制的来源；Claude 按拍板 A 原地读取，不复制。 */
export type ExternalSkillCopySourceId = 'codex' | 'cursor';

/** 带 MCP server 配置文件的来源（N-EXTHISTORY-IMPORT-K1B-MCP）。 */
export type ExternalMcpConfigSourceId = 'claude-code' | 'claude-desktop' | 'cursor' | 'codex';

export type ExternalImportCategory = 'instructions' | 'memories' | 'skills' | 'mcp';

export interface ExternalImportCategoryCount {
  category: ExternalImportCategory;
  count: number;
  /** true = 只读展示（Claude 技能原地读取 + 全局开关），不参与导入勾选 */
  readOnly?: boolean;
}

export interface ExternalImportSourceStatus {
  sourceId: ExternalImportSourceId;
  adapterId?: MemoryImportAdapterId;
  /** 来源主目录的展示形态（如 ~/.codex） */
  homePath: string;
  detected: boolean;
  categories: ExternalImportCategoryCount[];
  /** 检测期剔除该来源的原因（如 adapter 显式选择仍失败） */
  excludedReason?: string;
}

export interface ExternalImportDetectResult {
  /** 检测基准 home（CODE_AGENT_HOME 优先），展示用 */
  homeDir: string;
  sources: ExternalImportSourceStatus[];
  /** 任一来源 detected —— 设置页入口与记忆页链接的显隐判据 */
  anyDetected: boolean;
  claudeLegacySkills: {
    /** 原地读取开关当前生效值（缺省开） */
    enabled: boolean;
    /** ~/.claude/skills 下可被发现的技能数 */
    count: number;
  };
}

export interface ExternalSkillsPreviewRequest {
  sourceIds?: ExternalSkillCopySourceId[];
}

export interface ExternalSkillPlanItem {
  sourceId: ExternalSkillCopySourceId;
  name: string;
  sourcePath: string;
  disposition: 'copy' | 'skip';
  reason: 'new-skill' | 'target-name-exists';
}

export interface ExternalSkillsPreviewResult {
  items: ExternalSkillPlanItem[];
  summary: { copy: number; skip: number };
}

export interface ExternalSkillsApplyRequest {
  sourceIds?: ExternalSkillCopySourceId[];
}

export interface ExternalSkillsApplyResultItem {
  sourceId: ExternalSkillCopySourceId;
  name: string;
  action: 'copied' | 'skipped';
  reason?: 'target-name-exists' | 'copy-failed';
  error?: string;
  /** copied 时目录内容摘要（导入历史撤销用） */
  digest?: string;
}

export interface ExternalSkillsApplyResult {
  /** 复制目标（Neo 用户技能目录） */
  targetDir: string;
  copied: number;
  skipped: number;
  items: ExternalSkillsApplyResultItem[];
}

export interface ExternalImportSetClaudeLegacySkillsRequest {
  enabled: boolean;
}

export interface ExternalImportSetClaudeLegacySkillsResult {
  /** 落盘后回读的生效值（写失败时与请求值可能不同，UI 以此为准） */
  enabled: boolean;
}

// ----------------------------------------------------------------------------
// MCP servers 导入（N-EXTHISTORY-IMPORT-K1B-MCP）
// ----------------------------------------------------------------------------
//
// 拍板 A：全部以 enabled:false 写入 Neo 用户 mcp.json，逐个手动启用（启用前先看
// 完整命令行确认）；secret 形状值绝不落盘/回传/记日志，只记「需要哪个 KEY」的名字。

/** 单个来源配置文件的读取状态（缺文件是信息项，坏文件必须给原因，不静默空列表）。 */
export type ExternalMcpSourceFileStatus = 'ok' | 'missing' | 'unreadable' | 'invalid';

export interface ExternalMcpSourceFileReport {
  sourceId: ExternalMcpConfigSourceId;
  /** 来源配置文件绝对路径（展示/判因用） */
  configPath: string;
  status: ExternalMcpSourceFileStatus;
  /** status=unreadable/invalid 时的文件级原因（不含任何条目值） */
  error?: string;
}

export type ExternalMcpSkipReason =
  | 'source-disabled'
  | 'placeholder-in-command'
  | 'invalid-entry'
  | 'duplicate-across-sources'
  | 'already-exists'
  | 'name-conflict'
  | 'write-failed';

export interface ExternalMcpPlanItem {
  sourceId: ExternalMcpConfigSourceId;
  name: string;
  disposition: 'import' | 'skip';
  reason?: ExternalMcpSkipReason;
  /** stdio | 远程；skip 项也给（重复项灰显时仍要能认出来源与命令） */
  kind: 'stdio' | 'remote';
  /** 供预览/结果行与启用确认展示的命令摘要（stdio=command+args；远程=url），已过 secret 规则 */
  commandSummary: string;
  /** 被剥掉的 secret/占位符对应的 KEY 名字（仅名字，永不带值） */
  neededEnvKeys: string[];
  /** 跨来源/对既有配置去重用的键（stdio=command+args；远程=url） */
  dedupKey: string;
}

export interface ExternalMcpPreviewRequest {
  sourceIds?: ExternalMcpConfigSourceId[];
}

export interface ExternalMcpPreviewResult {
  files: ExternalMcpSourceFileReport[];
  items: ExternalMcpPlanItem[];
  summary: { import: number; skip: number };
}

export interface ExternalMcpApplyRequest {
  sourceIds?: ExternalMcpConfigSourceId[];
}

export interface ExternalMcpApplyResultItem extends ExternalMcpPlanItem {
  action: 'imported' | 'skipped';
  /** write-failed 时的宿主侧错误摘要（不含条目值） */
  error?: string;
}

export interface ExternalMcpApplyResult {
  /** 写入目标（Neo 用户 mcp.json） */
  targetPath: string;
  imported: number;
  skipped: number;
  items: ExternalMcpApplyResultItem[];
}
