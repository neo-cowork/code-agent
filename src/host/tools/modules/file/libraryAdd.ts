import fs from 'fs';
import path from 'path';
import type {
  CanUseToolFn,
  ToolContext,
  ToolHandler,
  ToolModule,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { UNSORTED_PROJECT_ID } from '../../../../shared/contract/project';
import { getUserConfigDir } from '../../../config/configPaths';
import { getDatabase } from '../../../services/core/databaseService';
import { getLibraryService } from '../../../services/library/libraryService';
import { isPathWithinRoot } from '../../../runtime/workspaceScope';
import { resolveInputPath } from '../../utils/resolveInputPath';
import { libraryAddSchema as schema } from './libraryAdd.schema';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const NEXT_STEP = 'Open the Library panel and upload it.';

function fail(code: string, error: string): ToolResult<string> {
  return { ok: false, code, error };
}

function displayName(requested: unknown, filePath: string): string {
  const fromArg = typeof requested === 'string' ? requested.trim() : '';
  const base = path.basename(fromArg || filePath).replace(/[\\/:*?"<>|]/g, '_').trim();
  return base.slice(0, 180) || 'file';
}

function parseTags(raw: unknown): string[] | undefined | null {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  const tags: string[] = [];
  for (const tag of raw) {
    if (typeof tag !== 'string') return null;
    const trimmed = tag.trim();
    if (trimmed.length === 0 || trimmed.includes('/') || trimmed.includes('\\')) continue;
    tags.push(trimmed);
  }
  return tags;
}

function sessionProjectId(sessionId: string): string | null {
  try {
    const projectId = getDatabase().getSession(sessionId)?.projectId;
    // The panel opens on the global scope; sessions without a project sit in the
    // reserved unsorted bucket, so store those items globally or they look missing.
    if (typeof projectId !== 'string' || !projectId.trim() || projectId === UNSORTED_PROJECT_ID) return null;
    return projectId;
  } catch {
    return null;
  }
}

function sourceInsideDataDir(resolved: string): boolean {
  try {
    return isPathWithinRoot(resolved, getUserConfigDir());
  } catch {
    return false;
  }
}

function savedSentence(title: string, learnFailed: boolean): string {
  if (learnFailed) {
    return `Saved "${title}" to the Library, but its text could not be read. It is still visible in the Library panel.`;
  }
  return `Saved "${title}" to the Library. It is visible in the Library panel.`;
}

function mapImportError(error: unknown): ToolResult<string> {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'ENOENT') return fail('FILE_NOT_FOUND', `That file could not be read. ${NEXT_STEP}`);
  if (code === 'EACCES' || code === 'EPERM') return fail('FILE_UNREADABLE', `That file could not be read. ${NEXT_STEP}`);
  if (code === 'EISDIR') return fail('NOT_A_FILE', `That path is not a file the Library can take. ${NEXT_STEP}`);
  if (/empty/i.test(message)) {
    return fail('EMPTY_FILE', `This file is empty, so the Library cannot take it. ${NEXT_STEP}`);
  }
  if (/MB limit/i.test(message)) {
    return fail('FILE_TOO_LARGE', `This file is over the 50MB limit, so the Library cannot take it. ${NEXT_STEP}`);
  }
  return fail('LIBRARY_ADD_FAILED', `The Library could not take that file. ${NEXT_STEP}`);
}

function inspectSource(resolved: string): ToolResult<string> | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    return mapImportError(error);
  }
  if (!stat.isFile()) return fail('NOT_A_FILE', `That path is not a file the Library can take. ${NEXT_STEP}`);
  if (stat.size === 0) return fail('EMPTY_FILE', `This file is empty, so the Library cannot take it. ${NEXT_STEP}`);
  if (stat.size > MAX_UPLOAD_BYTES) {
    return fail('FILE_TOO_LARGE', `This file is over the 50MB limit, so the Library cannot take it. ${NEXT_STEP}`);
  }
  return null;
}

async function executeLibraryAdd(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  if (typeof args.file_path !== 'string' || !args.file_path.trim()) {
    return fail('INVALID_ARGS', 'file_path is required.');
  }
  const tags = parseTags(args.tags);
  if (tags === null) return fail('INVALID_ARGS', 'tags must be a list of labels.');

  const resolved = resolveInputPath(args.file_path.trim(), ctx.workingDir);
  if (sourceInsideDataDir(resolved)) {
    return fail(
      'DATA_DIR_SOURCE',
      'The Library cannot take a file from the app\'s private data. Open the Library panel and upload a file from your workspace.',
    );
  }
  const rejected = inspectSource(resolved);
  if (rejected) return rejected;

  const explicitTitle = typeof args.title === 'string' && args.title.trim()
    ? displayName(args.title, resolved)
    : null;
  const title = explicitTitle ?? displayName(undefined, resolved);
  // The card names the file that is really copied; the model-chosen title is a second line only when it differs.
  const sourceName = displayName(undefined, resolved);
  const cardSummary = title === sourceName ? sourceName : `${sourceName}\n${title}`;
  const permit = await canUseTool(
    schema.name,
    { title },
    `Add "${title}" to the Library`,
    {
      sessionId: ctx.sessionId,
      forceConfirm: true,
      type: 'file_write',
      tool: schema.name,
      reason: 'This copies the file into the Library panel.',
      dangerLevel: 'normal',
      details: { title, preview: { type: 'generic', summary: cardSummary } },
    },
  );
  if (!permit.allow) return fail('PERMISSION_DENIED', `permission denied: ${permit.reason}`);
  if (ctx.abortSignal.aborted) return fail('ABORTED', 'aborted');

  onProgress?.({ stage: 'starting', detail: schema.name });
  try {
    const item = await getLibraryService().importFile({
      projectId: sessionProjectId(ctx.sessionId),
      sourcePath: resolved,
      tags,
      sourceSessionId: ctx.sessionId,
    });
    const named = explicitTitle && explicitTitle !== item.title
      ? getLibraryService().update(item.id, { title: explicitTitle }) ?? item
      : item;
    onProgress?.({ stage: 'completing', percent: 100 });
    return { ok: true, output: savedSentence(named.title, named.learnStatus === 'failed') };
  } catch (error) {
    return mapImportError(error);
  }
}

class LibraryAddHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ) {
    return executeLibraryAdd(args, ctx, canUseTool, onProgress);
  }
}

export const libraryAddModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler: () => new LibraryAddHandler(),
};
