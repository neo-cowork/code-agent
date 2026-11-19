// ============================================================================
// atMentionPanelModel - @ 触发面板的纯函数（分组 / 过滤 / 目录推导）
// ============================================================================
//
// 2026-07-29 UX round2 任务 14：@ 面板从「纯文件名子串列表」升级为 WorkBuddy 形态：
// 第一组「资料库」（当前项目 ∪ 全局架 pin 候选，口径与 host 注入一致，
// 复用 libraryItemModel 的 filterPinCandidates / matchesLibraryItemSearch），
// 第二组「工作区文件」（原有 listFiles 数据源）。两组各限 8 条，键盘导航在平铺
// 序列上循环。组件只负责渲染与副作用，分组/过滤规则全部落在这里便于测试。

import type { LibraryItem, LibraryItemKind } from '@shared/contract/library';
import type { ProjectArtifact, ProjectArtifactKind } from '@shared/contract/project';
import type { Session } from '@shared/contract/session';
import type { Translations } from '../../../../i18n';
import { filterPinCandidates, matchesLibraryItemSearch } from '../../knowledge/libraryItemModel';

/** 每组最多展示条数（资料库 / 工作区文件各自独立计算）。 */
const AT_MENTION_GROUP_LIMIT = 8;
const AT_MENTION_ALL_GROUP_LIMIT = 2;

export type AtMentionTab = 'all' | 'library' | 'files' | 'sessions' | 'artifacts';
export const AT_MENTION_TABS: readonly AtMentionTab[] = ['all', 'library', 'files', 'sessions', 'artifacts'];

export interface AtMentionFileMatch {
  path: string;
  name: string;
  isDirectory: boolean;
}

export interface AtMentionFileRow {
  kind: 'file';
  path: string;
  name: string;
  /** 所在目录（第二行灰字）；根目录文件为空串不渲染第二行 */
  dir: string;
  isDirectory: boolean;
}

export interface AtMentionLibraryRow {
  kind: 'library';
  item: LibraryItem;
  /** 已 pin 进本会话（行上显示 check 选中态） */
  pinned: boolean;
}

export interface AtMentionSessionRow {
  kind: 'session';
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  projectName: string;
}

type AtMentionArtifactType = 'html' | 'image' | 'document';

export interface AtMentionArtifactRow {
  kind: 'artifact';
  id: string;
  sessionId: string;
  sessionTitle: string;
  name: string;
  artifactType: AtMentionArtifactType;
  createdAt: number;
  path?: string;
  url?: string;
}

export type AtMentionRow = AtMentionFileRow | AtMentionLibraryRow | AtMentionSessionRow | AtMentionArtifactRow;

/** 'src/foo/bar.ts' → 'src/foo'；'bar.ts' → ''。host 端 join 的分隔符平台相关，尾部分隔符统一剥掉。 */
export function deriveFileDir(path: string, name: string): string {
  if (!path.endsWith(name)) return '';
  return path.slice(0, path.length - name.length).replace(/[\\/]$/, '');
}

/** 展示用目录：位于工作目录内 → 相对工作目录（根下文件为空串，子目录 'src'）；工作目录外保持绝对路径。选中/附件仍用 row.path（绝对）。 */
function deriveDisplayDir(path: string, name: string, baseDir: string | null | undefined): string {
  const dir = deriveFileDir(path, name);
  if (!baseDir) return dir;
  const base = baseDir.replace(/[\\/]+$/, '');
  if (dir === base) return '';
  if (dir.startsWith(`${base}/`) || dir.startsWith(`${base}\\`)) return dir.slice(base.length + 1);
  return dir;
}

/** 资料库行第二行灰字用的类型词条键：kind → i18n 词条（与 LibraryPanel 的 kindLabels 同一口径）。 */
const LIBRARY_KIND_LABEL_KEYS = {
  upload: 'kindUpload',
  artifact: 'kindArtifact',
  capture: 'kindCapture',
  external_ref: 'kindExternalRef',
} as const satisfies Record<LibraryItemKind, keyof Translations['library']>;

/** external_ref 的 pathOrUri 按 http(s) URL 解析出 host；不是合法 http(s) URL 时返回 null。 */
function httpHostOf(pathOrUri: string): string | null {
  try {
    const { protocol, host } = new URL(pathOrUri);
    return protocol === 'http:' || protocol === 'https:' ? host : null;
  } catch {
    return null;
  }
}

/**
 * 资料库行第二行灰字：summary 非空用 summary；否则用类型人话标签（external_ref 且
 * pathOrUri 解析为 http(s) URL 时附 host——URL 是用户认得出的东西）。绝不回退本地
 * pathOrUri：那是内部存储绝对路径（数据目录 library/proj_xxx/…），不该怼到用户面前。
 */
export function libraryRowSubtitle(item: LibraryItem, t: Translations): string {
  const summary = item.summary?.trim();
  if (summary) return summary;
  const label = t.library[LIBRARY_KIND_LABEL_KEYS[item.kind]];
  if (item.kind === 'external_ref') {
    const host = httpHostOf(item.pathOrUri);
    if (host) return `${label} · ${host}`;
  }
  return label;
}

/** 资料库组：pin 候选（本项目 ∪ 全局）按 query 过滤（空 query 全量），封顶 limit 条。 */
export function buildLibraryRows(
  items: LibraryItem[],
  projectId: string | null,
  pinnedIds: ReadonlySet<string>,
  query: string,
  limit = AT_MENTION_GROUP_LIMIT,
): AtMentionLibraryRow[] {
  const candidates = filterPinCandidates(items, projectId);
  const trimmed = query.trim();
  const filtered = trimmed
    ? candidates.filter((item) => matchesLibraryItemSearch(item, trimmed))
    : candidates;
  return filtered.slice(0, limit).map((item) => ({
    kind: 'library',
    item,
    pinned: pinnedIds.has(item.id),
  }));
}

/**
 * 工作区文件组：文件名子串过滤（大小写不敏感），封顶 limit 条。空 query（@ 一弹出）
 * 跳过 `.` 开头的条目——首屏只给真实工作区内容，不再被 .claude/.code-agent 占满；
 * 非空 query 行为不变，`@.`、`@claude` 仍能搜到点开头条目（对齐 vscode files.exclude 思路：
 * 默认藏起来但保持可搜索）。
 */
export function buildFileRows(
  files: AtMentionFileMatch[],
  query: string,
  limit = AT_MENTION_GROUP_LIMIT,
  baseDir?: string | null,
): AtMentionFileRow[] {
  const normalized = query.trim().toLowerCase();
  return files
    .filter((file) => (normalized
      ? file.name.toLowerCase().includes(normalized)
      : !file.name.startsWith('.')))
    .slice(0, limit)
    .map((file) => ({
      kind: 'file',
      path: file.path,
      name: file.name,
      dir: deriveDisplayDir(file.path, file.name, baseDir),
      isDirectory: file.isDirectory,
    }));
}

type SessionMatch = Session & { messageCount?: number };

export function buildSessionRows(
  sessions: SessionMatch[],
  projectNames: ReadonlyMap<string, string>,
  query: string,
  currentSessionId: string | null,
  limit = AT_MENTION_GROUP_LIMIT,
): AtMentionSessionRow[] {
  const normalized = query.trim().toLowerCase();
  return sessions
    .filter((session) => session.id !== currentSessionId)
    .map((session) => ({
      kind: 'session' as const,
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount ?? 0,
      projectName: (session.projectId && projectNames.get(session.projectId))
        || session.workspace
        || session.workingDirectory
        || '',
    }))
    .filter((row) => !normalized || [row.title, row.projectName].some((value) => value.toLowerCase().includes(normalized)))
    .slice(0, limit);
}

function classifyArtifact(kind: ProjectArtifactKind, name: string): AtMentionArtifactType {
  const extension = name.split('.').pop()?.toLowerCase();
  if (kind === 'image' || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(extension ?? '')) return 'image';
  if (kind === 'generic_html' || kind === 'web_snapshot' || extension === 'html' || extension === 'htm') return 'html';
  return 'document';
}

function artifactName(artifact: ProjectArtifact): string {
  const source = artifact.title || artifact.path || artifact.url || artifact.id;
  return source.split(/[\\/]/).pop() || source;
}

export function buildArtifactRows(
  artifacts: ProjectArtifact[],
  query: string,
  limit = AT_MENTION_GROUP_LIMIT,
): AtMentionArtifactRow[] {
  const normalized = query.trim().toLowerCase();
  return artifacts
    .map((artifact) => {
      const name = artifactName(artifact);
      return {
        kind: 'artifact' as const,
        id: artifact.id,
        sessionId: artifact.sessionId,
        sessionTitle: artifact.sessionTitle || '',
        name,
        artifactType: classifyArtifact(artifact.kind, name),
        createdAt: artifact.createdAt,
        path: artifact.path,
        url: artifact.url,
      };
    })
    .filter((row) => !normalized || [row.name, row.sessionTitle].some((value) => value.toLowerCase().includes(normalized)))
    .slice(0, limit);
}

export function groupLimitForTab(tab: AtMentionTab): number {
  return tab === 'all' ? AT_MENTION_ALL_GROUP_LIMIT : AT_MENTION_GROUP_LIMIT;
}

export function shiftAtMentionTab(tab: AtMentionTab, delta: number): AtMentionTab {
  const index = AT_MENTION_TABS.indexOf(tab);
  return AT_MENTION_TABS[wrapIndex(index, delta, AT_MENTION_TABS.length)];
}

/** 键盘导航的平铺序列：资料库在前、工作区文件在后（与面板渲染顺序一致）。 */
export function flattenAtMentionRows(
  libraryRows: AtMentionLibraryRow[],
  fileRows: AtMentionFileRow[],
  sessionRows: AtMentionSessionRow[] = [],
  artifactRows: AtMentionArtifactRow[] = [],
): AtMentionRow[] {
  return [...libraryRows, ...fileRows, ...sessionRows, ...artifactRows];
}

/** 循环位移：len 为 0 时返回 0（调用方此时不应进入导航分支）。 */
export function wrapIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return ((index + delta) % length + length) % length;
}
