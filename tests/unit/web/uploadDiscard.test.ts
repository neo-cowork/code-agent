import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applyTestSessionSchema } from '../../utils/applyTestSessionSchema';
import { handleDiscardUpload, UPLOAD_ROOT_DIR, ensureUploadRootDir } from '../../../src/web/helpers/upload';
import { MAX_UPLOAD_DISCARD_PATHS } from '../../../src/shared/constants/uploadDiscard';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/services/infra/logger', () => ({ createLogger: () => ({ warn, info: vi.fn() }) }));
let db: Database.Database;
let roots: string[];
function upload(name = 'reading-notes.txt') {
  const root = path.join(UPLOAD_ROOT_DIR, randomUUID());
  fs.mkdirSync(root, { recursive: true });
  roots.push(root);
  const file = path.join(root, name);
  fs.writeFileSync(file, 'Reading notes: outline the plan by Friday.');
  return file;
}
function discard(paths: unknown, database: Database.Database | null = db) {
  const req = { body: { paths } } as Request;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  handleDiscardUpload(req, res as unknown as Response, database);
  return res;
}
beforeEach(() => {
  roots = [];
  vi.clearAllMocks();
  ensureUploadRootDir();
  db = new Database(':memory:');
  applyTestSessionSchema(db);
  db.prepare(`INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at)
    VALUES ('s1', 'Upload discard test', 'test', 'test', 1, 1)`).run();
});
afterEach(() => {
  db.close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe('production upload discard handler', () => {
  it('removes only the unreferenced uuid directory and is idempotent', () => {
    const rejected = upload(), kept = upload();
    const res = discard([rejected]);
    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(fs.existsSync(path.dirname(rejected))).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
    expect(discard([rejected]).json).toHaveBeenCalledWith({ success: true });
  });
  it('ignores traversal, paths outside root, non-uuid dirs, root itself, and relative/non-string paths with distinct warnings', () => {
    const safe = upload();
    const nonUuid = path.join(UPLOAD_ROOT_DIR, 'not-a-uuid');
    fs.mkdirSync(nonUuid, { recursive: true });
    roots.push(nonUuid);
    fs.writeFileSync(path.join(nonUuid, 'notes.txt'), 'keep');
    const res = discard([
      `${path.dirname(safe)}/../${path.basename(path.dirname(safe))}/reading-notes.txt`,
      path.join(path.dirname(UPLOAD_ROOT_DIR), 'private.txt'),
      path.join(nonUuid, 'notes.txt'), UPLOAD_ROOT_DIR, 'uploads/relative.txt', null,
    ]);
    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(fs.existsSync(safe)).toBe(true);
    expect(fs.existsSync(path.join(nonUuid, 'notes.txt'))).toBe(true);
    expect(warn.mock.calls.map(([, data]) => data.reason)).toEqual([
      'traversal', 'outside-upload-root', 'non-uuid-directory', 'outside-upload-root', 'not-absolute-path', 'not-absolute-path',
    ]);
  });
  it.each(['content', 'attachments', 'metadata', 'tool_calls', 'tool_results'])('preserves a uuid referenced in message %s', (field) => {
    const kept = upload(), rejected = upload();
    db.prepare(`INSERT INTO messages (id, session_id, role, content, timestamp)
      VALUES ('m1', 's1', 'user', '', 1)`).run();
    db.prepare(`UPDATE messages SET ${field} = ? WHERE id = 'm1'`).run(JSON.stringify({ path: kept }));
    discard([kept, rejected]);
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(rejected)).toBe(false);
    expect(warn).toHaveBeenCalledWith('POST /api/upload/discard ignored', { reason: 'referenced-uuid', path: kept });
  });
  it('preserves uuids in queued inputs and scans references once per request', () => {
    const kept = upload(), rejected = upload();
    db.prepare(`INSERT INTO queued_inputs (id, session_id, envelope_json, created_at, updated_at)
      VALUES ('q1', 's1', ?, 1, 1)`).run(JSON.stringify({ attachments: [{ path: kept }] }));
    const prepare = vi.spyOn(db, 'prepare');
    discard([kept, rejected, rejected]);
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(rejected)).toBe(false);
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('FROM messages'))).toHaveLength(1);
    prepare.mockRestore();
  });
  it('keeps all data when database is unavailable or the reference scan fails', () => {
    const kept = upload();
    discard([kept], null);
    expect(fs.existsSync(kept)).toBe(true);
    db.exec('DROP TABLE queued_inputs');
    discard([kept]);
    expect(fs.existsSync(kept)).toBe(true);
    expect(warn.mock.calls.map(([, data]) => data.reason)).toEqual(['database-unavailable', 'reference-scan-failed']);
  });
  it('rejects malformed bodies and lists over 50 before deleting anything', () => {
    const file = upload();
    for (const paths of [undefined, file, Array(MAX_UPLOAD_DISCARD_PATHS + 1).fill(file)]) {
      expect(discard(paths).status).toHaveBeenCalledWith(400);
    }
    expect(fs.existsSync(file)).toBe(true);
  });
  it('does not follow a uuid symlink or a symlinked file escaping the uuid directory', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'discard-outside-'));
    roots.push(outside);
    const target = path.join(outside, 'notes.txt');
    fs.writeFileSync(target, 'keep outside');
    const uuidLink = path.join(UPLOAD_ROOT_DIR, randomUUID());
    roots.push(uuidLink);
    fs.symlinkSync(outside, uuidLink);
    const file = upload();
    const leafLink = path.join(path.dirname(file), 'escape.txt');
    fs.symlinkSync(target, leafLink);
    discard([path.join(uuidLink, 'notes.txt'), leafLink]);
    expect(fs.readFileSync(target, 'utf8')).toBe('keep outside');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.lstatSync(uuidLink).isSymbolicLink()).toBe(true);
    expect(warn.mock.calls.map(([, data]) => data.reason)).toEqual(['symlink-or-non-directory', 'symlink-or-non-directory']);
  });
});
