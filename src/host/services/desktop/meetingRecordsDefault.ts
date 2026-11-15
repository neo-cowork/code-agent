// ============================================================================
// 会议记录的默认实例（N-MEETING-PAGE）：录音库路径同 desktopAudioCapture.getSqlitePath（库不存在会先建），
// 走 sqlite3 CLI。纯存储逻辑在 meetingRecords.ts（测试直接注入 runner）。
// ============================================================================

import { execFileSync } from 'node:child_process';
import { createLogger } from '../infra/logger';
import { createMeetingRecordStore, type MeetingRecordStore } from './meetingRecords';

const logger = createLogger('MeetingRecords');

let defaultStore: MeetingRecordStore | null = null;

export async function getMeetingRecordStore(): Promise<MeetingRecordStore> {
  if (defaultStore) return defaultStore;
  const { getSqlitePath, ensureAudioTable } = await import('./desktopAudioCapture');
  let audioReady = false;
  defaultStore = createMeetingRecordStore((sql, json) => {
    const dbPath = getSqlitePath();
    if (!dbPath) return '';
    if (!audioReady) {
      ensureAudioTable(dbPath); // 会议表 join audio_segments：采集器从没写过时表可能还不存在
      audioReady = true;
    }
    try {
      return execFileSync('sqlite3', json ? ['-json', dbPath, sql] : [dbPath, sql], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      logger.warn('[会议] 读写会议记录失败', { error: error instanceof Error ? error.message : String(error) });
      return '';
    }
  });
  return defaultStore;
}
