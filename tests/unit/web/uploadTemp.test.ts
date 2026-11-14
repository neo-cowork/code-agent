// ============================================================================
// handleTempUpload 行为：multipart 字段完整性、大小上限、路径穿越、坏 Content-Type。
// 历史上 relativePath 字段截断会丢目录层级；本文件用真实 multipart body 回归。
// ============================================================================
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'node:stream';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applyTestSessionSchema } from '../../utils/applyTestSessionSchema';
import type { Request, Response } from 'express';
import {
  MAX_UPLOAD_SIZE,
  UPLOAD_ROOT_DIR,
  ensureUploadRootDir,
  handleTempBatchUpload,
  handleTempUpload,
  reapExpiredUploadDirs,
  scheduleExpiredUploadReap,
} from '../../../src/web/helpers/upload';
import {
  CHAT_UPLOAD_DIR_NAME,
  CHAT_UPLOAD_REAP_DELAY_MS,
  CHAT_UPLOAD_RETENTION_DAYS,
  CHAT_UPLOAD_SUBDIR_NAME,
} from '../../../src/shared/constants/chatUploads';
import { getUserDataPath } from '../../../src/host/platform/appPaths';
import { readModule } from '../../../src/host/tools/modules/file/read';
import { listDirectoryModule } from '../../../src/host/tools/modules/file/listDirectory';
import { globModule } from '../../../src/host/tools/modules/file/glob';
import { HostReasonCode } from '../../../src/shared/contract/permission';

function buildMultipart(parts: Array<{
  name: string;
  filename?: string;
  value: string | Buffer;
  contentType?: string;
}>, boundary = '----CodeAgentBoundary'): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename !== undefined) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`,
      ));
      chunks.push(Buffer.from(
        `Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
      ));
    } else {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`,
      ));
    }
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function makeReq(body: Buffer, contentType: string): Request {
  const stream = Readable.from([body]) as unknown as Request;
  (stream as Request).header = ((name: string) => {
    if (name.toLowerCase() === 'content-type') return contentType;
    return undefined;
  }) as Request['header'];
  (stream as Request).headers = { 'content-type': contentType };
  return stream;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & typeof res;
}

afterEach(() => {
  fs.rmSync(UPLOAD_ROOT_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('handleTempUpload', () => {
  it('rejects non-multipart content types with 400', async () => {
    const req = makeReq(Buffer.from('raw'), 'application/json');
    const res = makeRes();

    await handleTempUpload(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Expected multipart/form-data' });
  });

  it('preserves relativePath directory segments (field integrity)', async () => {
    const fileContent = Buffer.from('# hello from nested path');
    const { body, contentType } = buildMultipart([
      { name: 'file', filename: 'note.md', value: fileContent, contentType: 'text/markdown' },
      { name: 'relativePath', value: 'docs/nested/note.md' },
    ]);
    const res = makeRes();

    await handleTempUpload(makeReq(body, contentType), res);

    expect(res.statusCode).toBe(200);
    const savedPath = (res.body as { path: string }).path;
    expect(savedPath).toBeTruthy();
    expect(savedPath.startsWith(UPLOAD_ROOT_DIR)).toBe(true);
    expect(savedPath.replace(/\\/g, '/')).toMatch(/docs\/nested\/note\.md$/);
    expect(fs.readFileSync(savedPath)).toEqual(fileContent);
  });

  it('sanitizes path traversal in relativePath and keeps file under upload dir', async () => {
    const { body, contentType } = buildMultipart([
      { name: 'file', filename: 'evil.txt', value: 'payload' },
      { name: 'relativePath', value: '../../etc/passwd' },
    ]);
    const res = makeRes();

    await handleTempUpload(makeReq(body, contentType), res);

    expect(res.statusCode).toBe(200);
    const savedPath = path.resolve((res.body as { path: string }).path);
    const uploadRoot = path.resolve(UPLOAD_ROOT_DIR);
    // `..` segments are stripped; remaining names may look like etc/passwd but
    // must still resolve strictly inside the temp upload root (no host escape).
    expect(savedPath.startsWith(uploadRoot + path.sep)).toBe(true);
    expect(path.relative(uploadRoot, savedPath).startsWith('..')).toBe(false);
    expect(fs.existsSync(savedPath)).toBe(true);
    expect(fs.readFileSync(savedPath, 'utf8')).toBe('payload');
  });

  it('rejects uploads that exceed MAX_UPLOAD_SIZE', async () => {
    // Don't allocate 50MB+; stream more than the limit via a synthetic Readable.
    const boundary = '----OversizeBoundary';
    const header = Buffer.from(
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="big.bin"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n',
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    // body size = header + data + footer; data alone exceeds MAX_UPLOAD_SIZE
    const oversize = MAX_UPLOAD_SIZE + 1024;
    const dataChunk = Buffer.alloc(64 * 1024, 0x61);

    const stream = new Readable({
      read() {
        // no-op; we push below
      },
    }) as unknown as Request & Readable;

    (stream as Request).header = ((name: string) => {
      if (name.toLowerCase() === 'content-type') {
        return `multipart/form-data; boundary=${boundary}`;
      }
      return undefined;
    }) as Request['header'];
    (stream as Request).headers = {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    };

    const res = makeRes();
    const pending = handleTempUpload(stream as Request, res);

    stream.push(header);
    let sent = 0;
    while (sent < oversize) {
      const next = Math.min(dataChunk.length, oversize - sent);
      stream.push(dataChunk.subarray(0, next));
      sent += next;
    }
    stream.push(footer);
    stream.push(null);

    await expect(pending).rejects.toThrow(/exceeds .*MB limit/i);
  });

  it('uses basename of filename when relativePath is absent', async () => {
    const { body, contentType } = buildMultipart([
      { name: 'file', filename: 'plain.txt', value: 'just-a-file' },
    ]);
    const res = makeRes();

    await handleTempUpload(makeReq(body, contentType), res);

    expect(res.statusCode).toBe(200);
    const savedPath = (res.body as { path: string }).path;
    expect(path.basename(savedPath)).toBe('plain.txt');
    expect(fs.readFileSync(savedPath, 'utf8')).toBe('just-a-file');
  });
});

describe('handleTempUpload missing file field (error path)', () => {
  it('throws Missing file field when multipart has only text fields', async () => {
    const { body, contentType } = buildMultipart([
      { name: 'relativePath', value: 'only-meta.txt' },
    ]);
    const res = makeRes();

    await expect(handleTempUpload(makeReq(body, contentType), res)).rejects.toThrow(
      /Missing file field/,
    );
  });
});

describe('chat upload persistence and retention reaper', () => {
  function makeDb() {
    const db = new Database(':memory:');
    applyTestSessionSchema(db);
    return db;
  }

  function makeReadCtx() {
    const ctrl = new AbortController();
    return {
      sessionId: 'upload-test-session',
      agentId: 'upload-test-agent',
      workingDir: process.cwd(),
      abortSignal: ctrl.signal,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      emit: () => void 0,
    };
  }

  it('places UPLOAD_ROOT_DIR under getUserDataPath()/uploads rather than os.tmpdir()', () => {
    expect(UPLOAD_ROOT_DIR).toBe(path.join(getUserDataPath(), CHAT_UPLOAD_SUBDIR_NAME));
    expect(UPLOAD_ROOT_DIR.startsWith(os.tmpdir() + path.sep) && UPLOAD_ROOT_DIR.includes(CHAT_UPLOAD_DIR_NAME)).toBe(false);
  });

  it('keeps fresh single and batch uploads readable via Read after a simulated server restart', async () => {
    ensureUploadRootDir();

    const single = buildMultipart([
      { name: 'file', filename: 'clause3.md', value: 'Clause 3: Payment due within 30 days.', contentType: 'text/markdown' },
    ]);
    const singleRes = makeRes();
    await handleTempUpload(makeReq(single.body, single.contentType), singleRes);
    const singlePath = (singleRes.body as { path: string }).path;

    const batch = buildMultipart([
      { name: 'file0', filename: 'contract.md', value: 'Master Service Agreement — Fee $12,000', contentType: 'text/markdown' },
      { name: 'relativePath0', value: 'contracts/contract.md' },
    ]);
    const batchRes = makeRes();
    await handleTempBatchUpload(makeReq(batch.body, batch.contentType), batchRes);
    const batchPayload = batchRes.body as { root: string; files: Array<{ relativePath: string; path: string }> };
    const batchFilePath = batchPayload.files[0].path;

    // Simulate webServer startup sequence (reapExpiredUploadDirs + ensureUploadRootDir)
    const restartDb = makeDb();
    reapExpiredUploadDirs(restartDb);
    restartDb.close();
    ensureUploadRootDir();

    expect(fs.existsSync(singlePath)).toBe(true);
    expect(fs.existsSync(batchFilePath)).toBe(true);

    const handler = await readModule.createHandler();
    const singleRead = await handler.execute({ file_path: singlePath }, makeReadCtx(), async () => ({ allow: true }));
    expect(singleRead.ok).toBe(true);
    if (singleRead.ok) {
      expect(singleRead.output).toContain('Clause 3: Payment due within 30 days.');
    }

    const batchRead = await handler.execute({ file_path: batchFilePath }, makeReadCtx(), async () => ({ allow: true }));
    expect(batchRead.ok).toBe(true);
    if (batchRead.ok) {
      expect(batchRead.output).toContain('Master Service Agreement — Fee $12,000');
    }
  });

  it('removes upload subdirs older than CHAT_UPLOAD_RETENTION_DAYS and keeps younger subdirs', async () => {
    ensureUploadRootDir();

    const expiredUpload = buildMultipart([
      { name: 'file0', filename: 'old.md', value: 'expired contract', contentType: 'text/markdown' },
      { name: 'relativePath0', value: 'folder/old.md' },
    ]);
    const expiredRes = makeRes();
    await handleTempBatchUpload(makeReq(expiredUpload.body, expiredUpload.contentType), expiredRes);
    const expiredRoot = (expiredRes.body as { root: string; files: Array<{ path: string }> }).root;
    const expiredFile = (expiredRes.body as { files: Array<{ path: string }> }).files[0].path;

    const youngUpload = buildMultipart([
      { name: 'file', filename: 'recent.md', value: 'young contract', contentType: 'text/markdown' },
    ]);
    const youngRes = makeRes();
    await handleTempUpload(makeReq(youngUpload.body, youngUpload.contentType), youngRes);
    const youngFile = (youngRes.body as { path: string }).path;
    const youngRoot = path.dirname(youngFile);

    const dayMs = 24 * 60 * 60 * 1000;
    const expiredDate = new Date(Date.now() - (CHAT_UPLOAD_RETENTION_DAYS + 1) * dayMs);
    const youngDate = new Date(Date.now() - (CHAT_UPLOAD_RETENTION_DAYS - 1) * dayMs);
    fs.utimesSync(expiredRoot, expiredDate, expiredDate);
    fs.utimesSync(youngRoot, youngDate, youngDate);

    const db = makeDb();
    reapExpiredUploadDirs(db);
    db.close();

    expect(fs.existsSync(expiredRoot)).toBe(false);
    expect(fs.existsSync(expiredFile)).toBe(false);
    expect(fs.existsSync(youngRoot)).toBe(true);
    expect(fs.readFileSync(youngFile, 'utf8')).toBe('young contract');
  });

  it('keeps an over-retention upload still referenced by a session or queued message, removes unreferenced ones, and keeps everything when the DB is unavailable', async () => {
    ensureUploadRootDir();
    const upload = async (name: string) => {
      const { body, contentType } = buildMultipart([
        { name: 'file0', filename: name, value: `content of ${name}`, contentType: 'text/markdown' },
        { name: 'relativePath0', value: `folder/${name}` },
      ]);
      const res = makeRes();
      await handleTempBatchUpload(makeReq(body, contentType), res);
      return (res.body as { root: string; files: Array<{ path: string }> });
    };
    const referenced = await upload('referenced.md');
    const queued = await upload('queued.md');
    const orphan = await upload('orphan.md');

    const db = makeDb();
    db.prepare(`INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at)
      VALUES ('s1', 't', 'p', 'm', 1, 1)`).run();
    db.prepare(`INSERT INTO messages (id, session_id, role, content, timestamp) VALUES ('m1', 's1', 'user', ?, 1)`)
      .run(`请看附件 ${referenced.files[0].path}`);
    db.prepare(`INSERT INTO queued_inputs (id, session_id, envelope_json, created_at, updated_at) VALUES ('q1', 's1', ?, 1, 1)`)
      .run(JSON.stringify({ text: queued.files[0].path }));

    const old = new Date(Date.now() - (CHAT_UPLOAD_RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000);
    for (const u of [referenced, queued, orphan]) fs.utimesSync(u.root, old, old);

    reapExpiredUploadDirs(null);
    expect(fs.existsSync(orphan.root)).toBe(true);

    reapExpiredUploadDirs(db);
    db.close();

    expect(fs.existsSync(referenced.files[0].path)).toBe(true);
    expect(fs.existsSync(queued.files[0].path)).toBe(true);
    expect(fs.existsSync(orphan.root)).toBe(false);
  });

  it('reaps with a single streaming scan of messages regardless of how many expired dirs exist, and defers the scan off the startup path', async () => {
    ensureUploadRootDir();
    const roots: string[] = [];
    const old = new Date(Date.now() - (CHAT_UPLOAD_RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 6; i += 1) {
      const { body, contentType } = buildMultipart([
        { name: 'file0', filename: `f${i}.md`, value: 'x', contentType: 'text/markdown' },
        { name: 'relativePath0', value: `d/f${i}.md` },
      ]);
      const res = makeRes();
      await handleTempBatchUpload(makeReq(body, contentType), res);
      const root = (res.body as { root: string }).root;
      fs.utimesSync(root, old, old);
      roots.push(root);
    }
    const db = makeDb();
    const prepare = vi.spyOn(db, 'prepare');
    reapExpiredUploadDirs(db);
    const messageScans = prepare.mock.calls.filter(([sql]) => /FROM messages/.test(String(sql))).length;
    db.close();
    expect(messageScans).toBe(1);
    expect(roots.every((r) => !fs.existsSync(r))).toBe(true);

    vi.useFakeTimers();
    try {
      const lateDb = makeDb();
      const lateRoot = path.join(UPLOAD_ROOT_DIR, '22222222-2222-2222-2222-222222222222');
      fs.mkdirSync(lateRoot, { recursive: true });
      fs.utimesSync(lateRoot, old, old);
      scheduleExpiredUploadReap(lateDb);
      expect(fs.existsSync(lateRoot)).toBe(true);
      vi.advanceTimersByTime(CHAT_UPLOAD_REAP_DELAY_MS);
      expect(fs.existsSync(lateRoot)).toBe(false);
      lateDb.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still yields UploadExpired on ENOENT for legacy os.tmpdir()/code-agent-uploads paths', async () => {
    const legacyPath = path.join(os.tmpdir(), CHAT_UPLOAD_DIR_NAME, 'legacy-uuid-42', 'contract.md');
    const handler = await readModule.createHandler();
    const result = await handler.execute({ file_path: legacyPath }, makeReadCtx(), async () => ({ allow: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ENOENT');
      expect(result.meta?.hostReason).toMatchObject({
        code: HostReasonCode.UploadExpired,
      });
    }
  });

  it('yields UploadExpired for ListDirectory and Glob on a vanished upload directory', async () => {
    const gone = path.join(UPLOAD_ROOT_DIR, 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'file');
    const ask = async (mod: typeof listDirectoryModule | typeof globModule, input: Record<string, unknown>) => {
      const handler = await mod.createHandler();
      return handler.execute(input, makeReadCtx(), async () => ({ allow: true }));
    };
    for (const result of [
      await ask(listDirectoryModule, { path: gone }),
      await ask(globModule, { pattern: '**/*', path: gone }),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.meta?.hostReason).toMatchObject({ code: HostReasonCode.UploadExpired });
        expect(result.error).not.toContain('应用重启后');
      }
    }
  });
});
