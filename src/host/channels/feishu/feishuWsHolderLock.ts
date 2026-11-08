import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getUserConfigDir } from '../../config/configPaths';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('FeishuChannel');

interface FeishuWsHolderLockRecord {
  pid: number;
  dataDir: string;
  startedAt: number;
}

interface FeishuWsHolderClaimResult {
  otherHolderDetected: boolean;
  otherHolder?: FeishuWsHolderLockRecord;
}

const activeLockPaths = new Set<string>();
let exitHookRegistered = false;

function lockFilePath(appId: string, tmpDir: string = os.tmpdir()): string {
  const hash = createHash('sha256').update(appId).digest('hex').slice(0, 16);
  return path.join(tmpDir, `neo-feishu-ws-holder-${hash}.lock.json`);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EPERM') return true;
    return false;
  }
}

function readLockRecord(filePath: string): FeishuWsHolderLockRecord | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.debug('Feishu WS holder lock is not an object, treating as stale', { filePath });
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.pid !== 'number'
      || !Number.isInteger(record.pid)
      || record.pid <= 0
      || typeof record.dataDir !== 'string'
      || typeof record.startedAt !== 'number'
    ) {
      logger.debug('Feishu WS holder lock has invalid fields, treating as stale', { filePath });
      return null;
    }
    return {
      pid: record.pid,
      dataDir: record.dataDir,
      startedAt: record.startedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug('Failed to read Feishu WS holder lock, treating as stale', { filePath, error: message });
    return null;
  }
}

function releaseLockFileIfOwned(filePath: string, ownerPid: number = process.pid): void {
  activeLockPaths.delete(filePath);
  const existing = readLockRecord(filePath);
  if (existing?.pid !== ownerPid) return;
  try {
    unlinkSync(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug('Failed to remove Feishu WS holder lock', { filePath, error: message });
  }
}

function ensureProcessExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once('exit', () => {
    for (const filePath of Array.from(activeLockPaths)) {
      releaseLockFileIfOwned(filePath, process.pid);
    }
  });
}

/**
 * Claim the local advisory lock for a Feishu/Lark WebSocket appId after onReady.
 * Never throws into the connect path.
 */
export function claimFeishuWsHolderLock(appId: string): FeishuWsHolderClaimResult {
  const normalizedAppId = appId.trim();
  if (!normalizedAppId) return { otherHolderDetected: false };

  try {
    const filePath = lockFilePath(normalizedAppId);
    const existing = readLockRecord(filePath);
    let otherHolder: FeishuWsHolderLockRecord | undefined;

    if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
      otherHolder = existing;
      logger.warn('Another local Neo process holds a Feishu WebSocket connection for the same appId', {
        otherPid: existing.pid,
        otherDataDir: existing.dataDir,
        otherStartedAt: existing.startedAt,
      });
    }

    const nextRecord: FeishuWsHolderLockRecord = {
      pid: process.pid,
      dataDir: getUserConfigDir(),
      startedAt: Date.now(),
    };
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(nextRecord)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, filePath);
    activeLockPaths.add(filePath);
    ensureProcessExitHook();

    return otherHolder
      ? { otherHolderDetected: true, otherHolder }
      : { otherHolderDetected: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug('Failed to write Feishu WS holder lock', { error: message });
    return { otherHolderDetected: false };
  }
}

/**
 * Release the local advisory lock on disconnect/destroy if it is still owned by this process.
 */
export function releaseFeishuWsHolderLock(appId: string | undefined): void {
  const normalizedAppId = appId?.trim();
  if (!normalizedAppId) return;
  try {
    releaseLockFileIfOwned(lockFilePath(normalizedAppId), process.pid);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug('Failed to release Feishu WS holder lock', { error: message });
  }
}
