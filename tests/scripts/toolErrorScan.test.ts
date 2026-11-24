import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applyTestSessionSchema } from '../utils/applyTestSessionSchema';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scanner = path.join(repoRoot, 'scripts', 'corpus', 'tool-error-scan.py');
const patterns = path.join(repoRoot, 'src', 'shared', 'internalTextLeakPatterns.json');
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-error-scan-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('tool-error-scan.py', () => {
  it('counts model guidance in raw_error_hits but not visible_hits', () => {
    const dir = tempDir();
    const db = path.join(dir, 'fixture.db');
    const out = path.join(dir, 'counts.json');
    const result = {
      toolCallId: 'call-fixture',
      success: false,
      error: 'This location belongs to another Neo. Use MemoryRead to inspect its memories instead.',
      userMessage: '不能读取另一个对话的独立记忆目录。',
    };
    const modelResult = { toolCallId: result.toolCallId, success: result.success, error: result.error };
    const fixture = new Database(db);
    applyTestSessionSchema(fixture);
    fixture.prepare("INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at) VALUES (?, 'fixture', 'test', 'test', 0, 0)")
      .run('session-fixture');
    fixture.prepare('INSERT INTO messages (id, session_id, role, content, tool_results, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
      .run('message-fixture', 'session-fixture', 'tool', JSON.stringify([modelResult]), JSON.stringify([result]), 0);
    fixture.close();

    const scanned = spawnSync('python3', [scanner, '--patterns', patterns, '--db', db, '--out', out], { encoding: 'utf8' });
    expect(scanned.status, scanned.stderr).toBe(0);
    const counts = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(counts).toEqual({
      rows_scanned: 1,
      categories: {
        internal_tool_name: { rows_scanned: 1, raw_error_hits: 1, visible_hits: 0 },
        raw_json: { rows_scanned: 1, raw_error_hits: 0, visible_hits: 0 },
        injected_prompt: { rows_scanned: 1, raw_error_hits: 0, visible_hits: 0 },
      },
    });
    expect(JSON.parse(scanned.stdout)).toEqual(counts);
  });

  it('refuses a DB under the default data dir before opening it', () => {
    const dir = tempDir();
    const out = path.join(dir, 'counts.json');
    const db = path.join(os.homedir(), '.code-agent', 'must-not-open.db');
    const scanned = spawnSync('python3', [scanner, '--patterns', patterns, '--db', db, '--out', out], { encoding: 'utf8' });
    expect(scanned.status).toBe(2);
    expect(scanned.stderr).toContain('refusing to open a DB under a default data dir');
    expect(fs.existsSync(out)).toBe(false);
  });
});
