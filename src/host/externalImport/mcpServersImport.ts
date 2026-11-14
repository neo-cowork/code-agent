// ============================================================================
// MCP Servers Import - 从 Claude/Claude Desktop/Cursor/Codex 配置导入 MCP servers
// （N-EXTHISTORY-IMPORT-K1B-MCP-REDESIGN）
// ============================================================================
//
// 拍板 A（2026-11-02）：全部以 enabled:false 写进 Neo 用户 mcp.json，导入后逐个手动
// 启用（启用前 UI 先给完整命令行确认）。安全规则：
//   - secret 形状的 env/headers 值（key 命中 /key|token|secret|password|passwd|auth|
//     credential|bearer|cookie/i、值为 ${...} 占位符、Authorization 头）绝不写入、
//     绝不回传、绝不记日志——只记 KEY 名字（"needs <KEY>"）。
//   - Codex 的 bearer_token_env_var / env_http_headers / env_vars 只取名字进 needed。
//   - command/args/url 含 ${...} 的 server 整条跳过（Neo 无 ${VAR} 运行时展开）。
//   - 来源里已标记 disabled/enabled:false 的 server 跳过。
// 去重：同一 server（同 command+args 或同 url）跨来源只导入一次；Neo 侧任一 scope
// 已有同名同配置 → already-exists，同名不同配置 → name-conflict；导入两次零新增
// （persistMcpServerConfigToPath 对重名抛错，天然幂等）。

import * as fs from 'fs/promises';
import * as path from 'path';
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
 * 值内嵌 "Authorization":"Bearer ..."）。按 secret 处理：剥掉、只记 key 名。
 */
const HEADER_VALUE_KEY_RE = /headers?/i;
/** ${...} 占位符（值中出现即视为不可写入）。 */
const PLACEHOLDER_RE = /\$\{[^}]*\}/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function placeholderVarName(key: string, value: string): string {
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim());
  return match ? match[1] : key;
}

// ----------------------------------------------------------------------------
// 零依赖 TOML 子集解析器（覆盖 Codex ~/.codex/config.toml 所需语法；错误绝不回显原值）
// ----------------------------------------------------------------------------

class TomlCursor {
  pos = 0;
  constructor(readonly src: string) {}
  eof(): boolean { return this.pos >= this.src.length; }
  peek(offset = 0): string { return this.src[this.pos + offset] ?? ''; }

  skipSpaces(): void {
    while (!this.eof()) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t' || ch === '\r') this.pos += 1;
      else break;
    }
  }

  skipSpacesAndComments(): void {
    this.skipSpaces();
    if (this.peek() === '#') {
      while (!this.eof() && this.peek() !== '\n') this.pos += 1;
    }
  }

  skipBlankLines(): void {
    while (!this.eof()) {
      this.skipSpacesAndComments();
      if (this.peek() === '\n') this.pos += 1;
      else break;
    }
  }

  expectLineEnd(): void {
    this.skipSpacesAndComments();
    if (this.eof()) return;
    if (this.peek() === '\n') {
      this.pos += 1;
      return;
    }
    throw new Error('parse error');
  }

  readString(): string {
    const quote = this.peek();
    const triple = this.peek(1) === quote && this.peek(2) === quote;
    this.pos += triple ? 3 : 1;
    if (triple && this.peek() === '\n') this.pos += 1;
    else if (triple && this.peek() === '\r' && this.peek(1) === '\n') this.pos += 2;
    let out = '';
    while (!this.eof()) {
      if (triple && this.peek() === quote && this.peek(1) === quote && this.peek(2) === quote) {
        this.pos += 3;
        return out;
      }
      if (!triple && this.peek() === quote) {
        this.pos += 1;
        return out;
      }
      const ch = this.peek();
      if (!triple && (ch === '\n' || ch === '\r')) throw new Error('parse error');
      if (quote === '"' && ch === '\\') {
        this.pos += 1;
        if (this.eof()) throw new Error('parse error');
        const esc = this.peek();
        this.pos += 1;
        if (esc === '"' || esc === '\\' || esc === '/') out += esc;
        else if (esc === 'n') out += '\n';
        else if (esc === 'r') out += '\r';
        else if (esc === 't') out += '\t';
        else if (esc === 'b') out += '\b';
        else if (esc === 'f') out += '\f';
        else if (esc === 'u' || esc === 'U') {
          const len = esc === 'u' ? 4 : 8;
          const hex = this.src.slice(this.pos, this.pos + len);
          if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) throw new Error('parse error');
          this.pos += len;
          out += String.fromCodePoint(parseInt(hex, 16));
        } else if (triple && (esc === '\n' || esc === '\r' || esc === ' ' || esc === '\t')) {
          while (!this.eof() && /[ \t\r\n]/.test(this.peek())) this.pos += 1;
        } else {
          throw new Error('parse error');
        }
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    throw new Error('parse error');
  }

  readKeySegment(): string {
    this.skipSpaces();
    const ch = this.peek();
    if (ch === '"' || ch === '\'') {
      if (this.peek(1) === ch && this.peek(2) === ch) throw new Error('parse error');
      return this.readString();
    }
    const start = this.pos;
    while (!this.eof() && /[A-Za-z0-9_-]/.test(this.peek())) this.pos += 1;
    if (this.pos === start) throw new Error('parse error');
    return this.src.slice(start, this.pos);
  }

  readDottedKey(): string[] {
    const parts = [this.readKeySegment()];
    while (!this.eof()) {
      this.skipSpaces();
      if (this.peek() !== '.') break;
      this.pos += 1;
      parts.push(this.readKeySegment());
    }
    return parts;
  }

  readValue(): unknown {
    this.skipSpaces();
    const ch = this.peek();
    if (ch === '"' || ch === '\'') return this.readString();
    if (ch === '[') return this.readArray();
    if (ch === '{') return this.readInlineTable();

    const start = this.pos;
    while (!this.eof() && !/[ \t\r\n#,\]}]/.test(this.peek())) this.pos += 1;
    const raw = this.src.slice(start, this.pos);
    if (!raw) throw new Error('parse error');
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?)$/.test(raw)) {
      const normalized = raw.replace(/_/g, '');
      const num = Number(normalized);
      if (Number.isNaN(num)) throw new Error('parse error');
      return num;
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw;
    throw new Error('parse error');
  }

  private readArray(): unknown[] {
    this.pos += 1; // '['
    const items: unknown[] = [];
    for (;;) {
      this.skipBlankLines();
      if (this.eof()) throw new Error('parse error');
      if (this.peek() === ']') {
        this.pos += 1;
        return items;
      }
      items.push(this.readValue());
      this.skipBlankLines();
      if (this.peek() === ',') {
        this.pos += 1;
        continue;
      }
      if (this.peek() === ']') {
        this.pos += 1;
        return items;
      }
      throw new Error('parse error');
    }
  }

  private readInlineTable(): Record<string, unknown> {
    this.pos += 1; // '{'
    const table: Record<string, unknown> = {};
    for (;;) {
      this.skipBlankLines();
      if (this.eof()) throw new Error('parse error');
      if (this.peek() === '}') {
        this.pos += 1;
        return table;
      }
      const keyPath = this.readDottedKey();
      this.skipSpaces();
      if (this.peek() !== '=') throw new Error('parse error');
      this.pos += 1;
      const val = this.readValue();
      assignPath(table, keyPath, val);
      this.skipBlankLines();
      if (this.peek() === ',') {
        this.pos += 1;
        continue;
      }
      if (this.peek() === '}') {
        this.pos += 1;
        return table;
      }
      throw new Error('parse error');
    }
  }
}

function assignPath(target: Record<string, unknown>, keyPath: string[], value: unknown): void {
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const seg = keyPath[i];
    const existing = cursor[seg];
    if (existing === undefined) {
      const next: Record<string, unknown> = {};
      cursor[seg] = next;
      cursor = next;
    } else if (isRecord(existing)) {
      cursor = existing;
    } else {
      throw new Error('parse error');
    }
  }
  const leaf = keyPath[keyPath.length - 1];
  if (cursor[leaf] !== undefined) throw new Error('parse error');
  cursor[leaf] = value;
}

function ensureTablePath(root: Record<string, unknown>, keyPath: string[], arrayTable: boolean): Record<string, unknown> {
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const seg = keyPath[i];
    const existing = cursor[seg];
    if (existing === undefined) {
      const next: Record<string, unknown> = {};
      cursor[seg] = next;
      cursor = next;
    } else if (Array.isArray(existing)) {
      const last: unknown = existing[existing.length - 1];
      if (!isRecord(last)) throw new Error('parse error');
      cursor = last;
    } else if (isRecord(existing)) {
      cursor = existing;
    } else {
      throw new Error('parse error');
    }
  }
  const leaf = keyPath[keyPath.length - 1];
  const existing = cursor[leaf];
  if (arrayTable) {
    const item: Record<string, unknown> = {};
    if (existing === undefined) {
      cursor[leaf] = [item];
    } else if (Array.isArray(existing)) {
      existing.push(item);
    } else {
      throw new Error('parse error');
    }
    return item;
  }
  if (existing === undefined) {
    const next: Record<string, unknown> = {};
    cursor[leaf] = next;
    return next;
  }
  if (isRecord(existing)) return existing;
  throw new Error('parse error');
}

function parseCodexToml(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  const cursor = new TomlCursor(content);
  for (;;) {
    cursor.skipBlankLines();
    if (cursor.eof()) break;
    if (cursor.peek() === '[') {
      const arrayTable = cursor.peek(1) === '[';
      cursor.pos += arrayTable ? 2 : 1;
      const keyPath = cursor.readDottedKey();
      cursor.skipSpaces();
      if (arrayTable) {
        if (cursor.peek() !== ']' || cursor.peek(1) !== ']') throw new Error('parse error');
        cursor.pos += 2;
      } else {
        if (cursor.peek() !== ']') throw new Error('parse error');
        cursor.pos += 1;
      }
      cursor.expectLineEnd();
      current = ensureTablePath(root, keyPath, arrayTable);
      continue;
    }
    const keyPath = cursor.readDottedKey();
    cursor.skipSpaces();
    if (cursor.peek() !== '=') throw new Error('parse error');
    cursor.pos += 1;
    const val = cursor.readValue();
    cursor.expectLineEnd();
    assignPath(current, keyPath, val);
  }
  return root;
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
    return { status: 'unreadable', entries: [], error: `read failed: ${code ?? 'IO_ERROR'}` };
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
  if (mcpServers === undefined) return { status: 'missing', entries: [] };
  if (!isRecord(mcpServers)) {
    return { status: 'invalid', entries: [], error: 'mcpServers is not an object' };
  }
  const entries: RawMcpEntry[] = [];
  for (const [name, entry] of Object.entries(mcpServers)) {
    entries.push({ name, raw: isRecord(entry) ? entry : { __invalidShape: true } });
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
    return { status: 'unreadable', entries: [], error: `read failed: ${code ?? 'IO_ERROR'}` };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseCodexToml(content);
  } catch {
    return { status: 'invalid', entries: [], error: 'invalid TOML: parse error' };
  }
  const mcpServers = parsed.mcp_servers;
  if (mcpServers === undefined) return { status: 'missing', entries: [] };
  if (!isRecord(mcpServers)) {
    return { status: 'invalid', entries: [], error: 'mcp_servers is not a table' };
  }
  const entries: RawMcpEntry[] = [];
  for (const [name, entry] of Object.entries(mcpServers)) {
    entries.push({ name, raw: isRecord(entry) ? entry : { __invalidShape: true } });
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
  if (envHttpHeaders !== undefined && isRecord(envHttpHeaders)) {
    for (const value of Object.values(envHttpHeaders)) {
      if (typeof value === 'string' && value.length > 0) needed.push(value);
    }
  }

  const envVars = raw.env_vars;
  if (envVars !== undefined) {
    if (Array.isArray(envVars)) {
      for (const value of envVars) {
        if (typeof value === 'string' && value.length > 0) needed.push(value);
      }
    } else if (isRecord(envVars)) {
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

type ExternalMcpPlanItemInternal = ExternalMcpPlanItem & { config?: MCPServerConfig };

function mapEntry(sourceId: ExternalMcpConfigSourceId, entry: RawMcpEntry): ExternalMcpPlanItemInternal {
  const { raw } = entry;
  if (raw.__invalidShape === true) {
    return skipItem(sourceId, entry, 'stdio', '', 'invalid-entry');
  }
  if (raw.disabled === true || raw.enabled === false) {
    return skipItem(sourceId, entry, 'stdio', '', 'source-disabled');
  }

  const command = stringValue(raw, 'command');
  const url = stringValue(raw, 'url') ?? stringValue(raw, 'serverUrl');
  if (!command && !url) {
    return skipItem(sourceId, entry, 'stdio', '', 'invalid-entry');
  }

  const args = stringArrayValue(raw, 'args');
  if (raw.args !== undefined && args === null) {
    return skipItem(sourceId, entry, 'stdio', command ?? url ?? '', 'invalid-entry');
  }
  if ((command && PLACEHOLDER_RE.test(command))
    || (url && PLACEHOLDER_RE.test(url))
    || (args?.some((arg) => PLACEHOLDER_RE.test(arg)) === true)) {
    const rawSummary = command ? [command, ...(args ?? [])].join(' ') : (url ?? '');
    return skipItem(sourceId, entry, command ? 'stdio' : 'remote', rawSummary, 'placeholder-in-command');
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

export interface ExternalMcpImportDeps {
  listExistingServers?: () => Promise<MCPServerConfig[]>;
  persistServer?: (server: MCPServerConfig) => Promise<unknown>;
}

async function listExistingServersDefault(): Promise<MCPServerConfig[]> {
  const configs = new Map<string, MCPServerConfig>();
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
  const { persistMcpServerConfigToPath } = await import('../ipc/mcp.ipc');
  await ensureUserConfigDir();
  const persisted = await persistMcpServerConfigToPath(getMcpScopedConfigPaths().user, 'servers', server);
  const { getMCPClient } = await import('../mcp/mcpClient');
  getMCPClient().addServer({ ...server, scope: 'user' });
  return persisted;
}

function resolveSourceIds(sourceIds?: ExternalMcpConfigSourceId[]): ExternalMcpConfigSourceId[] {
  if (!sourceIds || sourceIds.length === 0) return ALL_MCP_SOURCES;
  return ALL_MCP_SOURCES.filter((id) => sourceIds.includes(id));
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
