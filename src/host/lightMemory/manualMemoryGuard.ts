import { createHash } from 'node:crypto';
import { createLogger } from '../services/infra/logger';
import {
  archiveMemoryFile,
  readMemoryFile,
  rebuildLightMemoryIndex,
  sanitizeLightMemoryFilename,
  writeLightMemoryFile,
  type LightMemoryFile,
} from './lightMemoryIpc';

const logger = createLogger('ManualMemoryGuard');

export function normalizeForCompare(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

type GuardOutcome = 'proceed' | 'skipped-equivalent' | 'diverted-to-candidate' | 'skipped-known';

export async function reconcileManualMemoryWrite(
  input: Pick<LightMemoryFile, 'filename' | 'name' | 'description' | 'type' | 'content'>
    & { source: 'session-judge' | 'role-writeback' },
): Promise<GuardOutcome> {
  const current = await readMemoryFile(input.filename, { strict: true });
  if (current?.source !== 'manual') return 'proceed';

  const normalized = normalizeForCompare(input.content);
  const target = { filename: current.filename, source: input.source };
  if (normalized === normalizeForCompare(current.content)) {
    logger.info('skipped-equivalent', target);
    return 'skipped-equivalent';
  }

  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  const pending = sanitizeLightMemoryFilename(current.filename, `-pending-${hash}`);
  try {
    await writeLightMemoryFile({
      ...input,
      filename: pending,
      status: 'candidate',
      // Manual entries created by Settings use canonical lowercase filenames.
      supersedes: current.filename.toLowerCase(),
    }, { createOnly: true });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code !== 'EEXIST' || failure.syscall !== 'link') throw error;
    logger.info('skipped-known', { ...target, pending });
    return 'skipped-known';
  }

  logger.info('diverted-to-candidate', { ...target, pending });
  await rebuildLightMemoryIndex();
  const { getDatabase } = await import('../services/core/databaseService');
  const db = getDatabase();
  if (db.isReady) {
    const { rebuildMemoryMirrorFromLightFiles } = await import('../memory/memoryEntryRuntime');
    await rebuildMemoryMirrorFromLightFiles(db);
  }
  return 'diverted-to-candidate';
}

export async function archiveSupersededManualMemory(file: LightMemoryFile): Promise<void> {
  const filename = file.supersedes;
  if (!filename || filename === file.filename) return;

  const target = await readMemoryFile(filename, { strict: true });
  if (target?.source !== 'manual' || target.type === 'directive' || (target.status ?? 'active') !== 'active') {
    logger.info('Superseded manual memory is missing or no longer eligible for archival', {
      filename,
      replacement: file.filename,
    });
    return;
  }
  await archiveMemoryFile(filename, file.filename);
}
