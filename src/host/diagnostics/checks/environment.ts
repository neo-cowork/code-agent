// ============================================================================
// Doctor Check - Environment / Database / Config / Disk
// 从原 src/host/ipc/doctor.ipc.ts 抽出，逻辑保持一致
// ============================================================================

import { existsSync } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import { DOCTOR_FIX_CODES } from '../../../shared/constants/doctor';
import { SQLITE_INTEGRITY } from '../../../shared/constants/database';
import { getUserConfigDir } from '../../config/configPaths';
import { describeIntegrityCheckStatus } from '../../services/core/database/integrityGate';
import { getLedgerCorruptionStreak } from '../../services/core/database/ledgerCorruptionMonitor';
import { describeBackupStatus } from '../../services/infra/dbBackup';
import type { DoctorItem } from '../types';
import { doctorCopy } from '../i18n/doctorCopy';

const REQUIRED_SESSION_COLUMNS = ['id', 'title', 'is_deleted', 'is_archived'] as const;

export function checkNodeVersion(): DoctorItem {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);
  const isPass = major >= 18;
  return {
    category: 'environment',
    name: 'Node.js version',
    status: isPass ? 'pass' : 'fail',
    message: `Node.js ${version}`,
    details: isPass ? undefined : 'Requires Node.js >= 18',
    suggestion: isPass ? undefined : doctorCopy().environment.upgradeNode,
    fix: isPass ? undefined : { code: DOCTOR_FIX_CODES.OPEN_RUNTIME_HELP },
  };
}

export function checkConfigDir(): DoctorItem {
  const configDir = getUserConfigDir();
  const exists = existsSync(configDir);
  return {
    category: 'config',
    name: 'Config directory',
    status: exists ? 'pass' : 'warn',
    message: exists ? configDir : 'Config directory not found',
    details: exists ? undefined : `Expected at ${configDir}`,
    suggestion: exists ? undefined : doctorCopy().environment.configDirAutoCreated,
    fix: exists ? undefined : { code: DOCTOR_FIX_CODES.OPEN_DATA_DIRECTORY },
  };
}

export async function checkDatabase(): Promise<DoctorItem> {
  const dbPath = join(getUserConfigDir(), 'code-agent.db');
  if (!existsSync(dbPath)) {
    return {
      category: 'database',
      name: 'SQLite database',
      status: 'warn',
      message: 'Database not found',
      suggestion: doctorCopy().environment.databaseAutoCreated,
    };
  }
  try {
    const stats = await stat(dbPath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
    const { getDatabase } = await import('../../services/core/databaseService');
    const database = getDatabase();
    const db = database.getDb();
    if (!db) {
      return {
        category: 'database',
        name: 'SQLite database',
        status: 'warn',
        message: `${sizeMB} MB · schema check unavailable`,
        details: dbPath,
        suggestion: doctorCopy().environment.databaseNotReady,
      };
    }
    const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name?: unknown }>;
    const columnNames = new Set(
      columns.map((column) => column.name).filter((name): name is string => typeof name === 'string'),
    );
    const missingColumns = REQUIRED_SESSION_COLUMNS.filter((column) => !columnNames.has(column));
    const backupStatus = describeBackupStatus(dbPath);
    const integrityStatus = describeIntegrityCheckStatus(getUserConfigDir());
    const readonly = typeof database.isDegradedMode === 'function' && database.isDegradedMode();
    const ledgerCorrupt = getLedgerCorruptionStreak();
    const extras = `backups ${backupStatus} · quick_check ${integrityStatus} · mode ${readonly ? 'readonly' : 'normal'} · ledger_corrupt ${ledgerCorrupt}`;
    if (missingColumns.length > 0) {
      return {
        category: 'database',
        name: 'SQLite database',
        status: 'fail',
        message: `sessions schema missing: ${missingColumns.join(', ')}`,
        details: `${sizeMB} MB · ${dbPath} · ${extras}`,
        suggestion: doctorCopy().environment.restartForMigration,
        fix: { code: DOCTOR_FIX_CODES.OPEN_DATA_DIRECTORY },
      };
    }
    const integrityFailed = integrityStatus.startsWith('failed')
      || integrityStatus === 'unrecoverable'
      || readonly
      || ledgerCorrupt >= SQLITE_INTEGRITY.LEDGER_CORRUPTION_THRESHOLD;
    return {
      category: 'database',
      name: 'SQLite database',
      status: integrityFailed ? 'warn' : 'pass',
      message: `${sizeMB} MB · ${extras}`,
      details: dbPath,
      suggestion: integrityFailed
        ? readonly
          ? 'Database is read-only. History and search work; new sessions, memory writes, and runs are refused. Corrupt files are isolated, never deleted.'
          : 'The next launch will try to restore from a backup. Corrupt files are isolated, never deleted.'
        : undefined,
    };
  } catch (err) {
    return {
      category: 'database',
      name: 'SQLite database',
      status: 'fail',
      message: 'Cannot read database',
      details: err instanceof Error ? err.message : String(err),
      suggestion: doctorCopy().environment.checkDatabasePermissions,
      fix: { code: DOCTOR_FIX_CODES.OPEN_DATA_DIRECTORY },
    };
  }
}

export async function checkDiskUsage(): Promise<DoctorItem> {
  const configDir = getUserConfigDir();
  if (!existsSync(configDir)) {
    return {
      category: 'disk',
      name: 'Disk usage',
      status: 'pass',
      message: 'No data directory',
    };
  }
  try {
    await stat(configDir);
    return {
      category: 'disk',
      name: 'Config directory size',
      status: 'pass',
      message: 'Checked',
      details: configDir,
    };
  } catch {
    return {
      category: 'disk',
      name: 'Disk usage',
      status: 'warn',
      message: 'Cannot check disk usage',
      suggestion: doctorCopy().environment.checkConfigDirAccess,
      fix: { code: DOCTOR_FIX_CODES.OPEN_DATA_DIRECTORY },
    };
  }
}
