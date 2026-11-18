// ============================================================================
// N-CLI-SESSION-TITLE — CLI 占位标题回填只改该改的行，并且第二次为 0
// ============================================================================

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { backfillCliPlaceholderSessionTitles } from '../../../src/host/telemetry/telemetrySessionTitleBackfill';

const LOGGER = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function insertSession(db: Database.Database, id: string, title: string): void {
  db.prepare(`
    INSERT INTO sessions (id, title, model_provider, model_name, session_type, created_at, updated_at)
    VALUES (?, ?, 'deepseek', 'deepseek-chat', 'chat', 0, 0)
  `).run(id, title);
}

function insertMessage(
  db: Database.Database,
  id: string,
  sessionId: string,
  content: string,
  timestamp: number,
  extra: { isMeta?: number; visibility?: string } = {},
): void {
  db.prepare(`
    INSERT INTO messages (id, session_id, role, content, timestamp, is_meta, visibility)
    VALUES (?, ?, 'user', ?, ?, ?, ?)
  `).run(id, sessionId, content, timestamp, extra.isMeta ?? 0, extra.visibility ?? 'active');
}

function titleOf(db: Database.Database, id: string): string {
  const row = db.prepare('SELECT title FROM sessions WHERE id = ?').get(id) as { title: string };
  return row.title;
}

function seed(db: Database.Database): void {
  insertSession(db, 'cli_session_1_ready', 'CLI Session 2026/9/7 10:00:00');
  insertMessage(db, 'm-ready-rewound', 'cli_session_1_ready', 'rewound prompt', 1, { visibility: 'rewound' });
  insertMessage(db, 'm-ready', 'cli_session_1_ready', 'first line of the task\nignored tail', 2);
  insertMessage(db, 'm-ready-later', 'cli_session_1_ready', 'later prompt', 3);

  insertSession(db, 'cli_session_2_long', 'CLI Session');
  insertMessage(db, 'm-long', 'cli_session_2_long', 'A'.repeat(60), 1);

  insertSession(db, 'cli_session_3_named', 'Ship the login fix');
  insertMessage(db, 'm-named', 'cli_session_3_named', 'this title stays', 1);

  insertSession(db, 'cli_session_4_empty', 'New Chat');

  insertSession(db, 'cli_session_5_meta', '新对话');
  insertMessage(db, 'm-meta', 'cli_session_5_meta', 'meta only', 1, { isMeta: 1 });

  insertSession(db, 'cli_session_6_blank', 'Session x');
  insertMessage(db, 'm-blank', 'cli_session_6_blank', '   \n', 1);

  insertSession(db, 'session_desktop_1', 'CLI Session');
  insertMessage(db, 'm-desktop', 'session_desktop_1', 'desktop prompt', 1);

  insertSession(db, 'cliXsession_1_a', 'CLI Session');
  insertMessage(db, 'm-wild', 'cliXsession_1_a', 'wildcard must not match', 1);
}

describe('backfillCliPlaceholderSessionTitles', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it('renames only placeholder CLI rows that have a visible user message, then changes nothing', () => {
    db = new Database(':memory:');
    applySchema(db, LOGGER);
    seed(db);

    expect(backfillCliPlaceholderSessionTitles(db)).toBe(2);
    expect(titleOf(db, 'cli_session_1_ready')).toBe('CLI Session 2026/9/7 10:00:00');
    expect(titleOf(db, 'cli_session_2_long')).toBe('CLI Session');

    expect(backfillCliPlaceholderSessionTitles(db, { apply: true })).toBe(2);
    expect(titleOf(db, 'cli_session_1_ready')).toBe('first line of the task');
    expect(titleOf(db, 'cli_session_2_long')).toBe(`${'A'.repeat(50)}...`);
    expect(titleOf(db, 'cli_session_3_named')).toBe('Ship the login fix');
    expect(titleOf(db, 'cli_session_4_empty')).toBe('New Chat');
    expect(titleOf(db, 'cli_session_5_meta')).toBe('新对话');
    expect(titleOf(db, 'cli_session_6_blank')).toBe('Session x');
    expect(titleOf(db, 'session_desktop_1')).toBe('CLI Session');
    expect(titleOf(db, 'cliXsession_1_a')).toBe('CLI Session');

    expect(backfillCliPlaceholderSessionTitles(db, { apply: true })).toBe(0);
    expect(titleOf(db, 'cli_session_1_ready')).toBe('first line of the task');
  });

  // N-FIX-TELEMETRY-RECOVERY-NOTICE-RESIDUE-SKILLDRAFT-TITLE：回填的降级标题经
  // deriveFallbackSessionTitle 继承 sessionTitleSource 的恢复提示清洗。
  it('titles notice-prefixed rows from the real text and leaves notice-only rows on the placeholder', () => {
    const LEGACY_NOTICE =
      '【历史恢复提示】原始 user 消息缺失；以下内容由脱敏后的 telemetry 重建，不是用户原话。路径、标识符、数字和敏感值可能已被缩写或替换，不要将它们当作可直接执行的精确文件或命令目标。';
    db = new Database(':memory:');
    applySchema(db, LOGGER);
    insertSession(db, 'cli_session_notice_prefixed', 'CLI Session');
    insertMessage(db, 'm-notice-prefixed', 'cli_session_notice_prefixed', `${LEGACY_NOTICE}\n\nfirst line of the restored task`, 1);
    insertSession(db, 'cli_session_notice_only', 'CLI Session');
    insertMessage(db, 'm-notice-only', 'cli_session_notice_only', `${LEGACY_NOTICE}\n\n`, 1);

    expect(backfillCliPlaceholderSessionTitles(db, { apply: true })).toBe(1);
    expect(titleOf(db, 'cli_session_notice_prefixed')).toBe('first line of the restored task');
    expect(titleOf(db, 'cli_session_notice_only')).toBe('CLI Session');
    const titles = [titleOf(db, 'cli_session_notice_prefixed'), titleOf(db, 'cli_session_notice_only')];
    expect(titles.join('\n')).not.toMatch(/历史恢复提示|telemetry|重建|脱敏|Appshot 会话/);
  });

  it('the script dry-run leaves the file alone and --apply is idempotent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-title-backfill-script-'));
    const dbPath = path.join(dir, 'sessions.db');
    const fileDb = new Database(dbPath);
    applySchema(fileDb, LOGGER);
    insertSession(fileDb, 'cli_session_9_script', 'CLI Session');
    insertMessage(fileDb, 'm-script', 'cli_session_9_script', 'script derived title', 1);
    fileDb.close();

    const tsx = path.join(repoRoot, 'node_modules/.bin/tsx');
    const script = path.join(repoRoot, 'scripts/repair/backfill-cli-session-titles.ts');
    const dry = execFileSync(tsx, [script, dbPath], { encoding: 'utf8' });
    expect(dry.trim()).toBe('would update 1');

    const afterDry = new Database(dbPath, { readonly: true });
    expect(titleOf(afterDry, 'cli_session_9_script')).toBe('CLI Session');
    afterDry.close();

    const applied = execFileSync(tsx, [script, dbPath, '--apply'], { encoding: 'utf8' });
    expect(applied.trim()).toBe('updated 1');
    const again = execFileSync(tsx, [script, dbPath, '--apply'], { encoding: 'utf8' });
    expect(again.trim()).toBe('updated 0');

    const after = new Database(dbPath, { readonly: true });
    expect(titleOf(after, 'cli_session_9_script')).toBe('script derived title');
    after.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
