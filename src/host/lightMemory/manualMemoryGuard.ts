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
import { classifyAgainstManualEntries, listActiveManualEntries } from './manualMemoryClassifier';

const logger = createLogger('ManualMemoryGuard');

export function normalizeForCompare(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

type GuardOutcome = 'proceed' | 'skipped-equivalent' | 'diverted-to-candidate' | 'skipped-known';

type GuardInput = Pick<LightMemoryFile, 'filename' | 'name' | 'description' | 'type' | 'content'>
  & { source: 'session-judge' | 'role-writeback' };

export async function reconcileManualMemoryWrite(input: GuardInput): Promise<GuardOutcome> {
  const current = await readMemoryFile(input.filename, { strict: true });
  if (current?.source === 'manual') {
    const target = { filename: current.filename, source: input.source };
    if (normalizeForCompare(input.content) === normalizeForCompare(current.content)) {
      logger.info('skipped-equivalent', target);
      return 'skipped-equivalent';
    }
    // Manual entries created by Settings use canonical lowercase filenames.
    return divertToCandidate(input, current.filename.toLowerCase(), current.filename);
  }

  const manualEntries = await listActiveManualEntries();
  if (manualEntries.length === 0) return 'proceed';
  const relation = await classifyAgainstManualEntries(manualEntries, input);
  if (relation.label === 'independent') return 'proceed';
  if (relation.label === 'equivalent') {
    logger.info('skipped-equivalent', { filename: relation.filename, source: input.source, semantic: true });
    return 'skipped-equivalent';
  }
  return divertToCandidate(
    input,
    relation.filename ? relation.filename.toLowerCase() : undefined,
    relation.filename ?? undefined,
    relation.reason ?? 'semantic-conflict',
  );
}

async function divertToCandidate(
  input: GuardInput,
  supersedes: string | undefined,
  targetFilename: string | undefined,
  reason?: string,
): Promise<GuardOutcome> {
  const hash = createHash('sha256').update(normalizeForCompare(input.content)).digest('hex').slice(0, 8);
  const pending = sanitizeLightMemoryFilename(targetFilename ?? input.filename, `-pending-${hash}`);
  const target = { filename: targetFilename ?? null, source: input.source };
  try {
    await writeLightMemoryFile({
      ...input,
      filename: pending,
      status: 'candidate',
      // Automatic writers here target the global store; a `type: project` fact must still be approvable (no project binding).
      scope: 'global',
      ...(supersedes ? { supersedes } : {}),
    }, { createOnly: true });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code !== 'EEXIST' || failure.syscall !== 'link') throw error;
    logger.info('skipped-known', { ...target, pending });
    return 'skipped-known';
  }

  logger.info('diverted-to-candidate', { ...target, pending, ...(reason ? { reason } : {}) });
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
