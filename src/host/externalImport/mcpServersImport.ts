// ============================================================================
// MCP Servers Import - 从 Claude/Claude Desktop/Cursor/Codex 配置导入 MCP servers
// （N-EXTHISTORY-IMPORT-K1B-MCP）
// ============================================================================
//
// 拍板 A（2026-11-02）：全部以 enabled:false 写进 Neo 用户 mcp.json，导入后逐个手动
// 启用（启用前 UI 先给完整命令行确认）。安全规则：
//   - secret 形状的 env/headers 值（key 命中 /key|token|secret|password|passwd|auth|
//     credential|bearer|cookie/i、值为 ${...} 占位符、Authorization 头）绝不写入、
//     绝不回传、绝不记日志——只记 KEY 名字（"needs <KEY>"）。
//   - Codex 的 bearer_token_env_var / env_http_headers / env_vars 只取名字进 needed。
//   - command/args/url 含 ${...} 的 server 整条跳过（对齐 openai/codex
//     external-agent-migration mcp.rs 的丢弃语义，Neo 无 ${VAR} 运行时展开）。
//   - 来源里已标记 disabled/enabled:false 的 server 跳过。
// 去重：同一 server（同 command+args 或同 url）跨来源只导入一次；Neo 侧任一 scope
// 已有同名同配置 → already-exists，同名不同配置 → name-conflict；导入两次零新增
// （persistMcpServerConfigToPath 对重名抛错，天然幂等）。
//
// 依赖注入：listExistingServers / persistServer 默认走动态 import（mcpClient /
// mcp.ipc），避免与 IPC 层静态互相 import 成环；调用方（mcp.ipc 路由）与测试都可显式注入。

import * as fs from 'fs/promises';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';
import { ensureUserConfigDir, getHomeDir, getMcpScopedConfigPaths } from '../config';
import { createLogger } from '../services/infra/logger';
import type { MCPServerConfig } from '../mcp/types';
import type {
  ExternalMcpApplyRequest,
  ExternalMcpApplyResult,
  ExternalMcpApplyResultItem,
  ExternalMcpConfigSourceId,
  ExternalMcpPlanItem,
  ExternalMcpPreviewRequest,
  ExternalMcpPreviewResult,
  ExternalMcpSkipReason,
  ExternalMcpSourceFileReport,
  ExternalMcpSourceFileStatus,
} from '../../shared/contract/externalImport';

/** 相对 getHomeDir()（CODE_AGENT_HOME 优先）的来源配置文件。 */
const MCP_SOURCE_FILES: Record<ExternalMcpConfigSourceId, string> = {
  'claude-code': '.claude.json',
  'claude-desktop': path.join('Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  cursor: path.join('.cursor', 'mcp.json'),
  codex: path.join('.codex', 'config.toml'),
};

/** 跨来源去重与页面来源排序的优先序（先出现的赢）。 */
const ALL_MCP_SOURCES: ExternalMcpConfigSourceId[] = ['claude-code', 'claude-desktop', 'cursor', 'codex'];

const logger = createLogger('ExternalMcpImport');

/** secret 判定的 key 正则（env key 与 header key 共用）。 */
const SECRET_KEY_RE = /key|token|secret|password|passwd|auth|credential|bearer|cookie/i;
/**
 * 值本身是序列化 header 表的 env key（如 Cursor Notion 的 OPENAPI_MCP_HEADERS：
 * 值内嵌 "Authorization":"Bearer ..."）。key 正则打不中它，值又不是 ${...} 占位符，
 * 但拷过去就是明文泄密——按 secret 处理：剥掉、只记 key 名。
 */
const HEADER_VALUE_KEY_RE = /headers?/i;
/** ${...} 占位符（值中出现即视为不可写入）。 */
const PLACEHOLDER_RE = /\$\{[^}]*\}/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function placeholderVarName(key: string, value: string): string {
  // 值是单个干净的 ${NAME} 时记 NAME（用户要补的就是这个变量），否则记配置键名。
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim());
  return match ? match[1] : key;
}

// ----------------------------------------------------------------------------
// 来源读取（每个文件一个 reader；坏文件给原因，不静默空列表）
// ----------------------------------------------------------------------------

interface RawMcpEntry {
  name: string;
  raw: Record<string, unknown>;
}

interface ExternalMcpSourceRead {
  status: ExternalMcpSourceFileStatus;
  entries: RawMcpEntry[];
  error?: string;
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** JSON 类来源（~/.claude.json / claude_desktop_config.json / ~/.cursor/mcp.json）：顶层 mcpServers。 */
async function readJsonMcpSource(filePath: string): Promise<ExternalMcpSourceRead> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'missing', entries: [] };
    return { status: 'unreadable', entries: [], error: `read failed: ${readError(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { status: 'invalid', entries: [], error: 'invalid JSON: parse error' };
  }
  if (!isRecord(parsed)) {
    return { status: 'invalid', entries: [], error: 'top-level value is not a JSON object' };
  }
  // 只取顶层 mcpServers（~/.claude.json 里 per-project 的 mcpServers 不导入）。
  const mcpServers = parsed.mcpServers;
  if (mcpServers === undefined) return { status: 'missing', entries: [], error: 'no top-level mcpServers key' };
  if (!isRecord(mcpServers)) {
    return { status: 'invalid', entries: [], error: 'mcpServers is not an object' };
  }
  const entries: RawMcpEntry[] = [];
  for (const [name, entry] of Object.entries(mcpServers)) {
    entries.push({ name, raw: isRecord(entry) ? entry : {} });
  }
  return { status: 'ok', entries };
}

/** TOML 来源（~/.codex/config.toml）：[mcp_servers.<name>] 表。 */
async function readCodexTomlSource(filePath: string): Promise<ExternalMcpSourceRead> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'missing', entries: [] };
    return { status: 'unreadable', entries: [], error: `read failed: ${readError(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = parseToml(content);
  } catch {
    return { status: 'invalid', entries: [], error: 'invalid TOML: parse error' };
  }
  if (!isRecord(parsed)) {
    return { status: 'invalid', entries: [], error: 'top-level value is not a TOML table' };
  }
  const mcpServers = parsed.mcp_servers;
  if (mcpServers === undefined) return { status: 'missing', entries: [], error: 'no mcp_servers table' };
  if (!isRecord(mcpServers)) {
    return { status: 'invalid', entries: [], error: 'mcp_servers is not a table' };
  }
  const entries: RawMcpEntry[] = [];
  for (const [name, entry] of Object.entries(mcpServers)) {
    entries.push({ name, raw: isRecord(entry) ? entry : {} });
  }
  return { status: 'ok', entries };
}

async function readExternalMcpSource(
  sourceId: ExternalMcpConfigSourceId,
  homeDir: string,
): Promise<ExternalMcpSourceRead & { configPath: string }> {
  const configPath = path.join(homeDir, MCP_SOURCE_FILES[sourceId]);
  const read = sourceId === 'codex'
    ? await readCodexTomlSource(configPath)
    : await readJsonMcpSource(configPath);
  return { ...read, configPath };
}

// ----------------------------------------------------------------------------
// 安全映射：raw entry → 计划条目（secret 只记名字）
// ----------------------------------------------------------------------------

function stringValue(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** string[] | undefined=缺省 | null=形状坏（条目级跳过）。 */
function stringArrayValue(raw: Record<string, unknown>, key: string): string[] | null | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === 'string') ? (value as string[]) : null;
}

/** 逐键过滤 env/headers：secret key、占位符值剥掉并记 KEY 名；形状坏返回 null（条目级跳过）。 */
function sanitizeStringMap(
  value: unknown,
  needed: string[],
  options?: { headerMapEnvKeys?: boolean },
): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== 'string') return null;
    if (SECRET_KEY_RE.test(key) || (options?.headerMapEnvKeys === true && HEADER_VALUE_KEY_RE.test(key))) {
      needed.push(key);
      continue;
    }
    if (PLACEHOLDER_RE.test(entryValue)) {
      needed.push(placeholderVarName(key, entryValue));
      continue;
    }
    result[key] = entryValue;
  }
  return result;
}

/** Authorization 头永不写入；其余头走同一 secret 规则。 */
function sanitizeHeaders(value: unknown, needed: string[]): Record<string, string> | null {
  const sanitized = sanitizeStringMap(value, needed);
  if (sanitized === null) return null;
  for (const key of Object.keys(sanitized)) {
    if (key.toLowerCase() === 'authorization') {
      delete sanitized[key];
      needed.push(key);
    }
  }
  return sanitized;
}

/** Codex 专属字段：只取名字进 needed（bearer_token_env_var / env_http_headers / env_vars）。 */
function collectCodexNeededKeys(raw: Record<string, unknown>, needed: string[]): void {
  const bearer = stringValue(raw, 'bearer_token_env_var');
  if (bearer) needed.push(bearer);

  const envHttpHeaders = raw.env_http_headers;
  if (envHttpHeaders !== undefined) {
    // 形状：header 名 → 环境变量名（值才是要记的 KEY）。
    if (isRecord(envHttpHeaders)) {
      for (const value of Object.values(envHttpHeaders)) {
        if (typeof value === 'string' && value.length > 0) needed.push(value);
      }
    }
  }

  const envVars = raw.env_vars;
  if (envVars !== undefined) {
    if (Array.isArray(envVars)) {
      for (const value of envVars) {
        if (typeof value === 'string' && value.length > 0) needed.push(value);
      }
    } else if (isRecord(envVars)) {
      // 兼容 map 形状：键与值都按变量名记（不写任何 env 条目）。
      for (const [key, value] of Object.entries(envVars)) {
        needed.push(key);
        if (typeof value === 'string' && value.length > 0) needed.push(value);
      }
    }
  }
}

function skipItem(
  sourceId: ExternalMcpConfigSourceId,
  entry: RawMcpEntry,
  kind: ExternalMcpPlanItem['kind'],
  commandSummary: string,
  reason: ExternalMcpSkipReason,
): ExternalMcpPlanItemInternal {
  return {
    sourceId,
    name: entry.name,
    disposition: 'skip',
    reason,
    kind,
    commandSummary,
    neededEnvKeys: [],
    dedupKey: '',
  };
}

/** 计划条目的内部形态：import 项多带剥好 secret 的待写配置（不出 IPC 面）。 */
type ExternalMcpPlanItemInternal = ExternalMcpPlanItem & { config?: MCPServerConfig };

/** 单条 raw entry → 计划条目（不做跨来源/既有去重）。 */
function mapEntry(sourceId: ExternalMcpConfigSourceId, entry: RawMcpEntry): ExternalMcpPlanItemInternal {
  const { raw } = entry;

  if (raw.disabled === true || raw.enabled === false) {
    return skipItem(sourceId, entry, 'stdio', '', 'source-disabled');
  }

  const command = stringValue(raw, 'command');
  const url = stringValue(raw, 'url') ?? stringValue(raw, 'serverUrl');

  if (!command && !url) {
    return skipItem(sourceId, entry, 'stdio', '', 'invalid-entry');
  }

  // args 形状坏 → 条目级跳过；command/args/url 含 ${...} → 整条跳过
  // （Neo 无运行时展开，写入即坏配置）。
  const args = stringArrayValue(raw, 'args');
  if (raw.args !== undefined && args === null) {
    return skipItem(sourceId, entry, 'stdio', command ?? url ?? '', 'invalid-entry');
  }
  if ((command && PLACEHOLDER_RE.test(command))
    || (url && PLACEHOLDER_RE.test(url))
    || (args?.some((arg) => PLACEHOLDER_RE.test(arg)) === true)) {
    return skipItem(sourceId, entry, command ? 'stdio' : 'remote', command ?? url ?? '', 'placeholder-in-command');
  }

  const needed: string[] = [];
  collectCodexNeededKeys(raw, needed);

  if (command) {
    const env = sanitizeStringMap(raw.env, needed, { headerMapEnvKeys: true });
    if (env === null) {
      return skipItem(sourceId, entry, 'stdio', command, 'invalid-entry');
    }
    const commandSummary = [command, ...(args ?? [])].join(' ');
    const config: MCPServerConfig = {
      name: entry.name,
      type: 'stdio',
      command,
      ...(args ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      enabled: false,
      scope: 'user',
    };
    return {
      sourceId,
      name: entry.name,
      disposition: 'import',
      kind: 'stdio',
      commandSummary,
      neededEnvKeys: dedupeNeeded(needed),
      dedupKey: JSON.stringify([command, ...(args ?? [])]),
      config,
    };
  }

  // 远程：type=sse 保 sse，其余（http/http-streamable/缺省）归 http-streamable。
  if (!url) return skipItem(sourceId, entry, 'remote', '', 'invalid-entry');
  const type = stringValue(raw, 'type');
  if (type !== undefined && type !== 'sse' && type !== 'http' && type !== 'http-streamable' && type !== 'stdio') {
    return skipItem(sourceId, entry, 'remote', url, 'invalid-entry');
  }
  if (type === 'stdio') {
    return skipItem(sourceId, entry, 'remote', url, 'invalid-entry');
  }
  const headers = sanitizeHeaders(raw.headers ?? raw.http_headers, needed);
  if (headers === null) {
    return skipItem(sourceId, entry, 'remote', url, 'invalid-entry');
  }
  const config = {
    name: entry.name,
    type: type === 'sse' ? ('sse' as const) : ('http-streamable' as const),
    serverUrl: url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    enabled: false,
    scope: 'user',
  } satisfies MCPServerConfig;
  return {
    sourceId,
    name: entry.name,
    disposition: 'import',
    kind: 'remote',
    commandSummary: url,
    neededEnvKeys: dedupeNeeded(needed),
    dedupKey: url,
    config,
  };
}

function dedupeNeeded(needed: string[]): string[] {
  return [...new Set(needed)].sort();
}

function configDedupKey(config: MCPServerConfig): string {
  if (config.type === 'sse' || config.type === 'http-streamable') return config.serverUrl;
  if (config.type === 'in-process') return `in-process:${config.name}`;
  return JSON.stringify([config.command, ...(config.args ?? [])]);
}

// ----------------------------------------------------------------------------
// 依赖注入面
// ----------------------------------------------------------------------------

export interface ExternalMcpImportDeps {
  /** Neo 侧既有 server（任一 scope）——默认从运行时 MCPClient 取，失败回落 user 配置文件。 */
  listExistingServers?: () => Promise<MCPServerConfig[]>;
  /** 写入一条 server（重名须抛错以保证幂等）——默认复用 mcp.ipc 的持久化。 */
  persistServer?: (server: MCPServerConfig) => Promise<unknown>;
}

async function listExistingServersDefault(): Promise<MCPServerConfig[]> {
  const configs = new Map<string, MCPServerConfig>();
  // 用户配置文件直读：上一轮导入刚落盘、还没进运行时 registry 的 server 也算「已有」，
  // 二次预览/导入的判定才和第一次的结果一致。
  try {
    const { loadMcpConfigFiles } = await import('../mcp/mcpConfigFile');
    for (const config of await loadMcpConfigFiles()) configs.set(config.name, config);
  } catch (error) {
    logger.warn('mcp config file read failed for existing-server dedup', { error: readError(error) });
  }
  try {
    const { getMCPClient } = await import('../mcp/mcpClient');
    for (const state of getMCPClient().getServerStates()) configs.set(state.config.name, state.config);
  } catch (error) {
    logger.warn('mcp client unavailable for existing-server dedup', { error: readError(error) });
  }
  return [...configs.values()];
}

async function persistServerDefault(server: MCPServerConfig): Promise<unknown> {
  // 动态 import：mcp.ipc 的路由表静态引本模块，反向静态引它会成环。
  const { persistMcpServerConfigToPath } = await import('../ipc/mcp.ipc');
  await ensureUserConfigDir();
  const persisted = await persistMcpServerConfigToPath(getMcpScopedConfigPaths().user, 'servers', server);
  const { getMCPClient } = await import('../mcp/mcpClient');
  getMCPClient().addServer({ ...server, scope: 'user' });
  return persisted;
}

function resolveSourceIds(sourceIds?: ExternalMcpConfigSourceId[]): ExternalMcpConfigSourceId[] {
  return sourceIds?.length
    ? sourceIds.filter((id) => id in MCP_SOURCE_FILES)
    : ALL_MCP_SOURCES;
}

// ----------------------------------------------------------------------------
// 计划（预览）与落盘
// ----------------------------------------------------------------------------

/** 读取选中来源 + 安全映射 + 跨来源与 Neo 既有去重。不写任何文件。 */
export async function planExternalMcpImport(
  payload?: ExternalMcpPreviewRequest,
  deps?: ExternalMcpImportDeps,
): Promise<ExternalMcpPreviewResult> {
  const { files, items } = await buildPlan(payload?.sourceIds, deps);
  return {
    files,
    items: items.map(stripConfig),
    summary: {
      import: items.filter((item) => item.disposition === 'import').length,
      skip: items.filter((item) => item.disposition === 'skip').length,
    },
  };
}

function stripConfig(item: ExternalMcpPlanItemInternal): ExternalMcpPlanItem {
  const { config: _config, ...rest } = item;
  return rest;
}

async function buildPlan(
  sourceIds: ExternalMcpConfigSourceId[] | undefined,
  deps?: ExternalMcpImportDeps,
): Promise<{ files: ExternalMcpSourceFileReport[]; items: ExternalMcpPlanItemInternal[] }> {
  const files: ExternalMcpSourceFileReport[] = [];
  const items: ExternalMcpPlanItemInternal[] = [];
  const seenDedupKeys = new Set<string>();

  for (const sourceId of resolveSourceIds(sourceIds)) {
    const read = await readExternalMcpSource(sourceId, getHomeDir());
    files.push({
      sourceId,
      configPath: read.configPath,
      status: read.status,
      ...(read.error ? { error: read.error } : {}),
    });
    if (read.status !== 'ok') {
      if (read.status === 'invalid' || read.status === 'unreadable') {
        // 坏文件必须有可区分的原因（可观测性规矩），条目静默为空才是 bug。
        logger.warn('external mcp source file unusable', { sourceId, status: read.status, error: read.error });
      }
      continue;
    }
    for (const entry of read.entries) {
      const item = mapEntry(sourceId, entry);
      if (item.disposition === 'import' && seenDedupKeys.has(item.dedupKey)) {
        items.push({ ...item, disposition: 'skip', reason: 'duplicate-across-sources' });
        continue;
      }
      if (item.disposition === 'import') seenDedupKeys.add(item.dedupKey);
      items.push(item);
    }
  }

  // Neo 既有 server：同名同配置 → already-exists；同名不同配置 → name-conflict。
  const existing = await (deps?.listExistingServers ?? listExistingServersDefault)();
  const existingByName = new Map(existing.map((config) => [config.name, configDedupKey(config)]));
  for (const item of items) {
    if (item.disposition !== 'import') continue;
    const existingKey = existingByName.get(item.name);
    if (existingKey === undefined) continue;
    item.disposition = 'skip';
    item.reason = existingKey === item.dedupKey ? 'already-exists' : 'name-conflict';
  }

  return { files, items };
}

/** 计划 + 把 import 项逐条写进 Neo 用户 mcp.json（enabled:false，重名抛错 → already-exists）。 */
export async function applyExternalMcpImport(
  payload?: ExternalMcpApplyRequest,
  deps?: ExternalMcpImportDeps,
): Promise<ExternalMcpApplyResult> {
  const persist = deps?.persistServer ?? persistServerDefault;
  const targetPath = getMcpScopedConfigPaths().user;
  const { items: planned } = await buildPlan(payload?.sourceIds, deps);
  const items: ExternalMcpApplyResultItem[] = [];
  let imported = 0;

  for (const item of planned) {
    if (item.disposition === 'skip' || !item.config) {
      items.push({ ...stripConfig(item), action: 'skipped' });
      continue;
    }
    try {
      await persist(item.config);
      imported += 1;
      items.push({ ...stripConfig(item), action: 'imported' });
    } catch (error) {
      const message = readError(error);
      if (message.includes('already exists')) {
        // persist 对重名抛错：导入第二次的每一条都落到这里，零新增。
        items.push({ ...stripConfig(item), action: 'skipped', reason: 'already-exists' });
      } else {
        logger.warn('external mcp server write failed', { sourceId: item.sourceId, name: item.name, error: message });
        items.push({ ...stripConfig(item), action: 'skipped', reason: 'write-failed', error: message });
      }
    }
  }

  return {
    targetPath,
    imported,
    skipped: items.length - imported,
    items,
  };
}

/**
 * 检测页计数：来源 MCP 配置文件是否存在 + 可导入候选数。
 * - 文件不存在 → filePresent=false（检测页不出 MCP 类别 chip，避免无配置机器全零噪音）。
 * - 文件存在但不可读/非法 → filePresent=true、count=0（预览会给出文件级原因）。
 */
export async function countExternalMcpImportCandidates(
  sourceId: ExternalMcpConfigSourceId,
  homeDir: string,
): Promise<{ filePresent: boolean; count: number }> {
  const read = await readExternalMcpSource(sourceId, homeDir);
  if (read.status === 'missing') return { filePresent: false, count: 0 };
  if (read.status !== 'ok') return { filePresent: true, count: 0 };
  return {
    filePresent: true,
    count: read.entries
      .map((entry) => mapEntry(sourceId, entry))
      .filter((item) => item.disposition === 'import')
      .length,
  };
}
